// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Check whether proxy-introduced delays match proxy configuration.
// TODO: Test more than just response_delay_pool directive.

import Promise from "bluebird";
import HttpTestCase from "../src/test/HttpCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as AddressPool from "../src/misc/AddressPool";
import * as Http from "../src/http/Gadgets";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import Test from "../src/overlord/Test";
import ConfigGen from "../src/test/ConfigGen";
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
        option: "bucket-speed-limit",
        type: "Number", // bytes/s
        default: "50000",
        description: "*delay_pool's individual-restore",
    },
    {
        option: "aggregate-speed-limit",
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
        configGen.addGlobalConfigVariation({aggregateSpeedLimit: [
            Config.BucketSpeedLimit * Config.ConcurrencyLevel
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

        // Keep this huge because our test assumes the restore rate never
        // overflows the bucket. TODO: Test overflows as well.
        const unlimited = Number.MAX_SAFE_INTEGER;

        if (Config.DelayClass === "response") {
            cfg.custom('response_delay_pool slowPool ' +
                       `individual-restore=${Config.BucketSpeedLimit} ` +
                       'individual-maximum=${unlimited} ' +
                       `aggregate-restore=${Config.AggregateSpeedLimit} ` +
                       'aggregate-maximum=${unlimited} ' +
                       'initial-bucket-level=90');
            cfg.custom('response_delay_pool_access slowPool allow delayed');
            return;
        }

        if (Config.DelayClass === "1") {
            cfg.custom('delay_pools 1');
            cfg.custom('delay_class 1 1');
            // delay_parameters pool-id aggregate
            cfg.custom(`delay_parameters 1 ${Config.AggregateSpeedLimit}/${unlimited}`);
            cfg.custom('delay_access 1 allow delayed');
            return;
        }

        if (Config.DelayClass === "3") {
            cfg.custom('delay_pools 1');
            cfg.custom('delay_class 1 3');
            // delay_parameters pool-id aggregate network individual
            cfg.custom(`delay_parameters 1 none none ${Config.BucketSpeedLimit}/${unlimited}`);
            cfg.custom('delay_access 1 allow delayed');
            // XXX: Disable IPv6 -- individual buckets do not support it!
            return;
        }

        assert(false); // CLI options parser missed an unknown --delay-class
    }


    async run(/*testRun*/) {
        // do not log large body handling details by default
        if (Config.LogBodies === undefined && Config.BodySize > 1*1024*1024)
            Config.LogBodies = 0;

        let slowSpeed = Config.AggregateSpeedLimit / Config.ConcurrencyLevel;
        if (slowSpeed > Config.BucketSpeedLimit)
            slowSpeed = Config.BucketSpeedLimit;

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
        testCase.expectLongerRuntime(new Date(1000 /* ms */ * Config.BodySize / Config.BucketSpeedLimit));
        testCase.client().request.for(resource);
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
