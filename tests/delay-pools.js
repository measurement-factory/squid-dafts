// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Check whether proxy-introduced delays match proxy configuration.
// TODO: Test more than just response_delay_pool directive.

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as Gadgets from "../src/misc/Gadgets";
import Body from "../src/http/Body";
import ConfigGen from "../src/test/ConfigGen";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";

import assert from "assert";

Config.Recognize([
    {
        // TODO: Rename.
        option: "speed",
        type: "String",
        enum: ["fast", "slow"],
        default: "slow",
        description: "whether to test using 'slow' transactions " +
            "(i.e. transactions that DUT should delay)",
    },
    {
        option: "delay-class",
        type: "String",
        enum: ["response", "1", "3"],
        default: "response",
        description: "response_delay_pool or a delay_class N",
    },
    {
        option: "individual-restore",
        type: "Number", // bytes/s
        default: "50000",
        description: "*delay_pool's individual-restore",
    },
    {
        option: "aggregate-restore",
        type: "Number", // bytes/s
        description: "*delay_pool's aggregate-restore",
    }
]);

const maxDeviation = 10.0; // percent

export default class MyTest extends Test {
    static Configurators() {
        assert(Config.BodySize >= 0, "positive body-size"); // TODO: Add Size option type

        const configGen = new ConfigGen();

        // custom default
        configGen.addGlobalConfigVariation({bodySize: [
            1024 * 1024, // 1 MB
        ]});

        // dynamic default
        configGen.addGlobalConfigVariation({aggregateRestore: [
            Config.IndividualRestore * Config.ConcurrencyLevel
        ]});

        configGen.addGlobalConfigVariation({speed: [
            "slow",
            "fast",
        ]});

        configGen.addGlobalConfigVariation({delayClass: [
            "response",
            "1",
            "3",
        ]});

        return configGen.generateConfigurators();
    }


    _configureDut(cfg) {
        cfg.custom('acl delayed urlpath_regex speed=slow');
        this._sendXff = false; // may be reset below

        // Keep this huge because our test assumes the restore rate never
        // overflows the bucket. TODO: Test overflows as well.
        // Use int32_t::max/2 to work around Squid delay_pools overflow bugs.
        // TODO: const unlimited = Number.MAX_SAFE_INTEGER;
        const unlimited = Math.floor((Math.pow(2, 32-1) - 1)/2);

        if (Config.DelayClass === "response") {
            cfg.custom('response_delay_pool slowPool ' +
                       `individual-restore=${Config.IndividualRestore} ` +
                       `individual-maximum=${unlimited} ` +
                       `aggregate-restore=${Config.AggregateRestore} ` +
                       `aggregate-maximum=${unlimited} ` +
                       'initial-bucket-level=90');
            cfg.custom('response_delay_pool_access slowPool allow delayed');
            return;
        }

        if (Config.DelayClass === "1") {
            cfg.custom('delay_pools 1');
            cfg.custom('delay_class 1 1');
            // delay_parameters pool-id aggregate
            cfg.custom(`delay_parameters 1 ${Config.AggregateRestore}/${unlimited}`);
            cfg.custom('delay_access 1 allow delayed');
            return;
        }

        if (Config.DelayClass === "3") {
            cfg.custom('delay_pools 1');
            cfg.custom('delay_class 1 3');
            // delay_parameters pool-id aggregate network individual
            cfg.custom(`delay_parameters 1 none none ${Config.IndividualRestore}/${unlimited}`);
            cfg.custom('delay_access 1 allow delayed');
            // prevent flooding the bucket with our `unlimited` level
            cfg.custom('delay_initial_bucket_level 0');

            // We add (fake) IPv4 Forwarded-For addresses to work around Squid
            // inability to use individual buckets with IPv6 client addresses
            // and so that each concurrent test case uses a different
            // individual bucket.
            this._sendXff = true;
            cfg.custom('delay_pool_uses_indirect_client on');
            cfg.custom('follow_x_forwarded_for allow all');
            cfg.custom('acl fromLocalhost src 127.0.0.1/8');
            cfg.custom('http_access allow fromLocalhost');
            return;
        }

        assert(false); // CLI options parser missed an unknown --delay-class
    }


    async run(testRun) {
        let slowSpeed = Config.AggregateRestore / Config.ConcurrencyLevel;
        if (slowSpeed > Config.IndividualRestore)
            slowSpeed = Config.IndividualRestore;

        let expectedSpeed;
        let description;
        if (Config.Speed === "slow") {
            expectedSpeed = slowSpeed;
            description = 'Expecting ' + expectedSpeed + ' byte/s response transmission';
        } else {
            expectedSpeed = slowSpeed * 2; // XXX: minimum speed, actually
            description = 'Expecting very fast response transmission';
        }

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.uri.makeUnique("/speed=" + Config.Speed + "/");
        resource.body = new Body(Gadgets.RandomText("body-", Config.BodySize));

        let testCase = new HttpTestCase(description);
        testCase.expectLongerRuntime(new Date(1000 /* ms */ * Config.BodySize / Config.IndividualRestore));

        testCase.client().request.for(resource);
        if (this._sendXff) {
            const clientId = testRun.id;
            // Squid does not use higher bits for indexing individual buckets;
            // can be relaxed to only restrict IDs of _concurrent_ test cases
            assert(clientId <= 255*255);
            // TODO: Send both XFF and the recently standardized Forwarded-For?
            testCase.client().request.header.add("X-Forwarded-For", Gadgets.Number2ipv4(clientId));
        }

        testCase.server().serve(resource);
        testCase.server().response.header.add("Speed", Config.Speed);

        testCase.addMissCheck();
        testCase.check(() => {
            testCase.expectStatusCode(200);

            const startDate = testCase.server().transaction().startTime();
            const endDate = testCase.client().transaction().receivedEverythingTime();

            const elapsedSec = (endDate.getTime() - startDate.getTime()) / 1000.0;
            const speed = Config.BodySize / elapsedSec;
            if (Config.Speed === "slow") {
                const deviation = 100. * Math.abs(speed - expectedSpeed) / expectedSpeed;
                console.log("Actual speed=%d byte/s; deviation (from the expected %d byte/s) is %d%%",
                    speed.toFixed(0), expectedSpeed.toFixed(0), deviation.toFixed(1));
                assert(deviation <= maxDeviation);
            } else {
                console.log("Actual speed=%d byte/s; expected at least %d byte/s",
                    speed.toFixed(0), expectedSpeed.toFixed(0));
                assert(speed >= expectedSpeed);
            }

            // TODO: Test other response_delay_pool parameters as well.
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

}
