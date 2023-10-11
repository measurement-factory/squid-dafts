// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether Squid grows cached HTTP response header beyond
// reply_header_max_size when updating cached headers using 304 responses.
// See also: tests/proxy-update-headers-after-304.js

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as ConfigurationGenerator from "../src/test/ConfigGen";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Http from "../src/http/Gadgets";
import Field from "../src/http/Field";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";

import assert from "assert";

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
        option: "reply-header-max-size",
        type: "Number",
        description: "squid.conf::reply_header_max_size value (bytes)",
    },
]);

export default class MyTest extends Test {

    _configureDut(cfg) {
        assert(Config.dutMemoryCache() || Config.dutDiskCache());
        cfg.workers(Config.workers());
        cfg.dedicatedWorkerPorts(Config.workers() > 1);
        this._workerListeningAddresses = cfg.workerListeningAddresses();
        cfg.custom(`reply_header_max_size ${Config.replyHeaderMaxSize()} bytes`);
    }

    static Configurators() {
        const configGen = new ConfigurationGenerator.FlexibleConfigGen();

        configGen.workers(function *() {
            yield 1; // minimal working configuration
            yield 5; // the number of test cases; see Config.pokeSameWorker()
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

        configGen.replyHeaderMaxSize(function *() {
            yield 8*1024-1; // odd; smaller than default, but big enough to accommodate most customizations
            yield 64*1024; // Squid's default; String::SizeMax_ is 64*1024-1
            yield 2*1024*1024; // bigger than default, but small enough to keep a test run under a second
        });

        return configGen.generateConfigurators();
    }

    // reply_header_max_size includes response status-line size
    prefixSizeMax() { return Config.replyHeaderMaxSize(); }

    async run(/*testRun*/) {
        const resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.expireAt(FuzzyTime.Soon());
        resource.finalize();

        // single byte growth of this small field pushes Squid over the prefix limit
        const fieldThatWillGrow = new Field(Http.DaftFieldName("Update"), 'x');
        const grownField = fieldThatWillGrow.clone();
        grownField.value += "y";

        {
            fieldThatWillGrow.finalize();
            const prefixSize = this.prefixSizeMax() - fieldThatWillGrow.raw().length;
            const testCase = new HttpTestCase(`cache ${prefixSize}-byte response prefix which is smaller than the ${this.prefixSizeMax()}-byte maximum`);

            testCase.client().request.for(resource);
            testCase.client().nextHopAddress = this._workerListeningAddressFor(1);

            testCase.server().serve(resource);
            testCase.server().response.enforceMinimumPrefixSize(prefixSize);

            testCase.check(() => {
                testCase.client().expectStatusCode(200);
            });
            testCase.addMissCheck();

            await testCase.run();
            await this.dut.finishCaching();
        }

        {
            const testCase = new HttpTestCase('verify that the proxy cached the response with a smaller-than-allowed prefix');
            testCase.client().request.for(resource);
            testCase.client().nextHopAddress = this._workerListeningAddressFor(2);
            testCase.client().request.conditions({ ims: resource.notModifiedSince() });

            testCase.check(() => {
                testCase.client().expectStatusCode(304);
            });

            await testCase.run();
        }

        // our approximation of what we expect the proxy to have in its cache
        let cachedResponse = null;

        {
            const testCase = new HttpTestCase(`grow cached prefix size to match the ${this.prefixSizeMax()}-byte maximum`);

            resource.modifyNow();
            resource.expireAt(FuzzyTime.DistantFuture());

            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.modifiedSince() });
            testCase.client().request.header.add("Cache-Control", "max-age=0");
            testCase.client().nextHopAddress = this._workerListeningAddressFor(3);

            testCase.server().serve(resource);
            testCase.server().response.startLine.code(304);
            testCase.server().response.header.add(fieldThatWillGrow);

            testCase.check(() => {
                testCase.client().expectStatusCode(200);
                testCase.client().transaction().response.header.expectField(fieldThatWillGrow);
            });

            await testCase.run();
            // XXX: this.dut.finishCaching() does not see prefix-updating disk I/O
            // await this.dut.finishCaching();

            cachedResponse = testCase.client().transaction().response;
        }

        {
            const testCase = new HttpTestCase('verify that we cached the response with a maximum-allowed prefix');

            testCase.client().request.for(resource);
            // TODO: This is step 4, not 3, but we use the previous step ID to
            // work around dut.finishCaching() inability to see disk updates.
            testCase.client().nextHopAddress = this._workerListeningAddressFor(3);

            testCase.addHitCheck(cachedResponse);

            await testCase.run();
        }

        {
            const testCase = new HttpTestCase(`attempt to push cached prefix size beyond the ${this.prefixSizeMax()}-byte maximum`);

            resource.modifyNow();
            resource.expireAt(FuzzyTime.DistantFuture());

            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.modifiedSince() });
            testCase.client().request.header.add("Cache-Control", "max-age=0");
            testCase.client().nextHopAddress = this._workerListeningAddressFor(5);

            testCase.server().serve(resource);
            testCase.server().response.startLine.code(304);
            testCase.server().response.header.add(grownField);
            // expect 2 transactions: revalidation and then unconditional GET
            testCase.server().keepListening(true);

            testCase.check(() => {
                assert.strictEqual(testCase.server().transactionsFinished(), 2);

                testCase.client().expectStatusCode(200);
                assert(!testCase.client().transaction().response.header.has(grownField.name));
            });
            testCase.addMissCheck();

            this.dut.ignoreProblems(/Failed to update.*exceed/);

            await testCase.run();
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
        return this._workerListeningAddresses[offset];
    }
}

