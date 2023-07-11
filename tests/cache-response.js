// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

/* Tests basic caching: Storing a cache miss and serving a cache hit. */

import assert from "assert";
import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

Config.Recognize([
    {
        option: "workers",
        type: "Number",
        description: "the number of Squid worker processes",
    },
    {
        option: "poke-same-worker",
        type: "Boolean",
        description: "send all test case requests to the same Squid worker process",
    },
]);

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.bodySize(function *() {
            yield Config.DefaultBodySize();

            yield 0;
            yield 1;
            yield Config.LargeBodySize();
            yield Config.HugeCachableBodySize();
        });

        configGen.responseEndsAtEof(function *() {
            yield false;
            yield true;
        });

        configGen.workers(function *() {
            yield 1;
            yield 4;
        });

        configGen.pokeSameWorker(function *(cfg) {
            if (cfg.workers() > 1) // poking different workers requires multiple workers
                yield false;
            yield true;
        });

        configGen.dutMemoryCache(function *() {
            yield false;
            yield true;
        });

        configGen.dutDiskCache(function *(cfg) {
            if (cfg.dutMemoryCache()) // do not end up with no caching at all
                yield false;
            yield true;
        });

        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        cfg.workers(Config.workers()); // TODO: This should be the default.
        cfg.dedicatedWorkerPorts(Config.workers() > 1); // TODO: This should be the default.

        // TODO: There should be no need to remember these, as they are always
        // available via this.dut.config(), which should cache them.
        this._workerListeningAddresses = cfg.workerListeningAddresses();
    }

    async run(/*testRun*/) {
        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.finalize();

        let missCase = new HttpTestCase(`cache a response`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        missCase.client().nextHopAddress = this._workerListeningAddressFor(1);
        missCase.addMissCheck();
        await missCase.run();

        await this.dut.finishCaching();

        let hitCase = new HttpTestCase(`hit the cached response`);
        hitCase.client().request.for(resource);
        hitCase.client().nextHopAddress = this._workerListeningAddressFor(2);
        hitCase.addHitCheck(missCase.server().transaction().response);
        await hitCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    // TODO: Move/Refactor into Proxy::workerForStep().primaryAddress(): The
    // primary listening address of the round-robin selected worker. Here,
    // "primary" means a worker-designated address (if it exists) or the
    // general proxy listening address (otherwise).
    _workerListeningAddressFor(stepId)
    {
        assert(stepId >= 1);

        let workerId = 1;
        if (!Config.pokeSameWorker()) {
            // use workers in round-robin fashion, using the first worker for
            // the first step; both worker and step IDs are 1-based
            assert(Config.workers() > 0);
            workerId = 1 + ((stepId-1) % Config.workers());
        }

        // The first this._workerListeningAddresses element is a well-known
        // port address shared by all workers. We do not use it here.
        const offset = 1 + (workerId - 1);
        assert(offset >= 0);
        assert(offset < this._workerListeningAddresses.length);
        return this._workerListeningAddresses[offset];
    }
}
