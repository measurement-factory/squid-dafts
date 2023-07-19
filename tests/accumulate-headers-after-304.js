// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether an HTTP proxy does not allow to increase an HTTP response header
// via 304 responses more than the specified limit.

import HttpTestCase from "../src/test/HttpCase";
import Field from "../src/http/Field";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as ConfigurationGenerator from "../src/test/ConfigGen";
import * as AddressPool from "../src/misc/AddressPool";
import * as Http from "../src/http/Gadgets";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import assert from "assert";
import Test from "../src/overlord/Test";

const DefaultPrefixSizeKB = 64;
const DefaultPrefixSize = DefaultPrefixSizeKB*1024;

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
    {
        option: "max-prefix-size",
        type: "Number",
        default: DefaultPrefixSize.toString(),
        description: "maximum message body size (KB)",
    },
]);

export default class MyTest extends Test {

    _configureDut(cfg) {
        assert(Config.dutMemoryCache() || Config.dutDiskCache());
        cfg.workers(Config.workers());
        cfg.dedicatedWorkerPorts(Config.workers() > 1);
        this._workerListeningAddresses = cfg.workerListeningAddresses();
        cfg.custom(`reply_header_max_size ${Config.maxPrefixSize()} KB`);
    }

    static Configurators() {
        const configGen = new ConfigurationGenerator.FlexibleConfigGen();

        configGen.workers(function *() {
            yield 1;
            yield 5;
        });

        configGen.pokeSameWorker(function *(cfg) {
            if (cfg.workers() > 1) // poking different workers requires multiple workers
                yield false;
            yield true;
        });

        configGen.dutMemoryCache(function *(cfg) {
            yield false;
            yield true;
        });

        configGen.dutDiskCache(function *(cfg) {
            if (cfg.dutMemoryCache()) // do not end up with no caching at all
                yield false;
            yield true;
        });

        configGen.maxPrefixSize(function *(cfg) {
            yield 8;
            yield 32;
            yield 64;
            yield 128;
            yield 2048;
        });

        return configGen.generateConfigurators();
    }

    maxPrefixSize() { return Config.maxPrefixSize() * 1024; }

    async run(/*testRun*/) {
        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.expireAt(FuzzyTime.Soon());
        resource.finalize();

        // This header appears in the initially cached response.
        // This header does not appear in the updatingResponse.
        // This header must upppear in the updatedResponse.
        const hitCheck = new Field(Http.DaftFieldName("Hit-Check"), Gadgets.UniqueId("check"));

        const updateHeaderName = Http.DaftFieldName("Update");
        let updateField = new Field(updateHeaderName, 'x');
        updateField.finalize();
        const updateHeaderLength = updateField.raw().length;

        {
            const prefixSize = this.maxPrefixSize() - updateHeaderLength;
            let testCase = new HttpTestCase(`forward a cachable response with a prefix size less than the maximum allowed ${prefixSize}<${this.maxPrefixSize()}`);
            testCase.client().request.for(resource);
            testCase.client().nextHopAddress = this._workerListeningAddressFor(1);
            testCase.server().serve(resource);
            testCase.server().response.enforceMinimumPrefixSize(prefixSize);
            testCase.server().response.header.add(hitCheck);
            testCase.client().checks.add((client) => {
                client.expectStatusCode(200);
            });
            await testCase.run();
        }

        {
            let testCase = new HttpTestCase('respond with a 304 hit');
            testCase.client().request.for(resource);
            testCase.client().nextHopAddress = this._workerListeningAddressFor(2);
            testCase.client().request.conditions({ ims: resource.notModifiedSince() });
            testCase.client().checks.add((client) => {
                client.expectStatusCode(304);
            });
            await testCase.run();
            await this.dut.finishCaching();
        }

        let updatingResponse = null;
        {
            let testCase = new HttpTestCase(`attempt to increase the cached prefix size up to the maximum allowed: ${this.maxPrefixSize()}`);

            resource.modifyNow();
            resource.expireAt(FuzzyTime.DistantFuture());

            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.modifiedSince() });
            testCase.client().request.header.add("Cache-Control", "max-age=0");
            testCase.client().nextHopAddress = this._workerListeningAddressFor(3);

            testCase.server().response.header.add(updateField);
            testCase.server().response.startLine.code(304);
            testCase.server().serve(resource);
            testCase.check(() => {
                updatingResponse = testCase.server().transaction().response;
                const receivedResponse = testCase.client().transaction().response;
                assert(receivedResponse.startLine.codeInteger() === 200);
                assert.equal(receivedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
            });

            await testCase.run();
            // XXX: Does not work when updating headers
            // await this.dut.finishCaching();
        }

        {
            let testCase = new HttpTestCase(`hit the cached entry with the maximum allowed prefix: ${this.maxPrefixSize()} `);
            testCase.client().request.for(resource);
            // TODO: should be step '4'. Temporarily set as the previous step to overcome
            // the 'dut.finishCaching()' problem for updates
            testCase.client().nextHopAddress = this._workerListeningAddressFor(3);
            testCase.check(() => {
                let updatedResponse = testCase.client().transaction().response;
                const code = updatedResponse.startLine.codeInteger();
                assert.equal(code, 200);
                assert.equal(updatingResponse.id(), updatedResponse.id(), "updated X-Daft-Response-ID");
                assert.equal(updatedResponse.header.values("Last-Modified"), resource.lastModificationTime.toUTCString(), "updated Last-Modified");
            });
            await testCase.run();
        }

        {
            let testCase = new HttpTestCase(`attempt to make the cached prefix size greater than the maximum allowed: ${this.maxPrefixSize()}+1`);

            resource.modifyNow();
            resource.expireAt(FuzzyTime.DistantFuture());

            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.modifiedSince() });
            testCase.client().request.header.add("Cache-Control", "max-age=0");
            testCase.client().nextHopAddress = this._workerListeningAddressFor(5);

            testCase.server().response.header.addOverwrite(updateHeaderName, "xy");

            testCase.server().response.startLine.code(304);
            testCase.server().keepListening('always');
            testCase.server().serve(resource);
            testCase.check(() => {
                const receivedResponse = testCase.client().transaction().response;
                assert(receivedResponse.startLine.codeInteger() === 200);
                assert(!receivedResponse.header.has(hitCheck.name));
                // allow the server argent to stop and the transaction to finish
                testCase.server().keepListening('never');
            });

            let started = testCase.run();
            await testCase.server().transaction().sentEverything();
            // handle proxy's retry attempt (after discovering that it's got too large prefix)
            testCase.server().resetTransaction();
            await started;
        }

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
        console.log("Adress: === " + this._workerListeningAddresses[offset].port + " " + offset + " " + this._workerListeningAddresses.length);
        return this._workerListeningAddresses[offset];
    }
}

