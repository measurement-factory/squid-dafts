// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// When a proxy revalidates a cached response (because either that response or
// the client request requires such revalidation), the proxy ought to cache a
// cachable 200 OK revalidation response.

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as Http from "../src/http/Gadgets";
import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

// the highest worker ID we are using (via _workerListeningAddressFor() calls)
const WorkerIdMax = 3;

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        default: WorkerIdMax.toString(),
        description: "the number of proxy SMP workers",
    },
    {
        option: "poke-same-worker",
        type: "Boolean",
        description: "send all test case requests to one SMP worker",
    },
    {
        option: "external-refresh",
        type: "Boolean",
        description: "whether to force revalidation using request headers",
    },
    {
        // TODO: Other tests that are affected by Store-related event
        // timings/order might benefit from this testing mode as well.
        // However, most non-validation tests probably care about the timing
        // of _received_ (by the client or DUT) response headers instead.
        option: "separate-sent-response-headers-from-body",
        type: "Boolean",
        description: "whether the server should wait for the response headers " +
            "to be sent before sending the response body",
    },
]);


export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.workers(function *() {
            yield 1;
            yield WorkerIdMax;
        });

        configGen.pokeSameWorker(function *(cfg) {
            yield true; // makes sense in SMP and non-SMP modes
            if (cfg.workers() > 1)
                yield false; // makes sense in SMP mode only
        });

        configGen.externalRefresh(function *() {
            yield true;
            yield false;
        });

        configGen.separateSentResponseHeadersFromBody(function *() {
            yield true;
            yield false;
        });

        return configGen.generateConfigurators();
    }

    constructor() {
        super(...arguments);

        this._resource = null; // generated, cached, and updated by test cases
    }

    _configureDut(cfg) {
        cfg.workers(Config.workers()); // TODO: This should be the default.
        cfg.dedicatedWorkerPorts(Config.workers() > 1); // for simplicity sake; TODO: Do this by default.

        // TODO: Make configurable.
        // TODO: Try all three sensible combinations (by default).
        cfg.memoryCaching(false);
        cfg.diskCaching(true);

        this._workerListeningAddresses = cfg.workerListeningAddresses();
    }

    async run(/*testRun*/) {
        const originAddress = AddressPool.ReserveListeningAddress();

        assert(!this._resource);
        this._resource = new Resource();
        this._resource.uri.address = originAddress;
        this._resource.makeCachable();
        this._resource.requireRevalidationOnEveryUse(!Config.externalRefresh());
        this._resource.finalize();

        const initialResponse = await this._cacheCurrentResource();
        await this._checkCached(initialResponse);

        const updatingResponse = await this._updateResource();
        await this._checkCached(updatingResponse);

        AddressPool.ReleaseListeningAddress(originAddress);
    }

    async _cacheCurrentResource() {
        let testCase = new HttpTestCase('forward a cachable response');

        testCase.client().nextHopAddress = this._workerListeningAddressFor(1);
        testCase.client().request.for(this._resource);

        testCase.server().serve(this._resource);
        testCase.server().response.tag("first");

        testCase.addMissCheck();

        await testCase.run();
        await this.dut.finishCaching();
        return testCase.server().transaction().response;
    }

    async _updateResource()
    {
        let testCase = new HttpTestCase('force a refresh miss that replaces the previously cached response');

        this._resource.modifyNow();

        testCase.client().nextHopAddress = this._workerListeningAddressFor(2);
        testCase.client().request.for(this._resource);
        if (Config.externalRefresh())
            testCase.client().request.header.add("Cache-Control", "max-age=0");

        testCase.server().serve(this._resource);
        testCase.server().response.tag("second");

        if (Config.separateSentResponseHeadersFromBody()) {
            testCase.server().transaction().blockSendingBodyUntil(
                testCase.server().transaction().sentHeaders(),
                "pause to send the new response body separately from headers");
        }

        testCase.addMissCheck();

        await testCase.run();
        await this.dut.finishCaching();
        return testCase.server().transaction().response;
    }

    async _checkCached(response) {
        const rid = response.id();
        const testCase = new HttpTestCase(`check that the previous origin server response (${rid}) got cached`);

        testCase.client().nextHopAddress = this._workerListeningAddressFor(3);
        testCase.client().request.for(this._resource);

        testCase.server().serve(this._resource);
        if (!Config.externalRefresh()) {
            // XXX: Configure server transaction to respond with 304, but only to conditional requests.
            testCase.server().response.startLine.code(304);
            // This helps confirm that the original response was not purged.
            testCase.server().response.header.prohibitDaftMarkings(); // TODO: Do this by default on 304s.

            // Compared to `response`, a 304 response may have a slightly
            // different Date header, so we should not addHitCheck(response).
            testCase.client().checks.add(() => {
                Http.AssertRefreshHit(
                    response,
                    testCase.server().transaction().response,
                    testCase.client().transaction().response);
            });
        } else {
            testCase.addHitCheck(response);
        }


        await testCase.run();
    }

    _workerListeningAddressFor(caseId)
    {
        // our default Config.workers() value ought to allow poking of unique workers
        assert(caseId <= WorkerIdMax);

        if (Config.pokeSameWorker())
            return Config.proxyAuthority();

        // The first this._workerListeningAddresses element is a well-known
        // port address shared by all workers. We do not use it and iterate
        // over the remaining n-1 worker-specific addresses instead. Also, our
        // caseId is 1-based, so we adjust to use the first worker-dedicated
        // port for the first test case.
        assert(this._workerListeningAddresses.length > 1);
        assert(caseId >= 1);
        const offset = (caseId - 1) % (this._workerListeningAddresses.length - 1);
        return this._workerListeningAddresses[1 + offset];
    }
}
