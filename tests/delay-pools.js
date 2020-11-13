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
        option: "bucket-speed-limit",
        type: "Number",
        default: "50000",
        description: "response_delay_pool's individual-restore",
    },
    {
        option: "aggregate-speed-limit",
        type: "Number",
        description: "response_delay_pool's aggregate-restore",
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

        return configGen.generateConfigurators();
    }


    _configureDut(cfg) {
        cfg.custom('acl slowResponse rep_header Speed ^slow');
        cfg.custom('response_delay_pool slowPool ' +
                   `individual-restore=${Config.BucketSpeedLimit} ` +
                   'individual-maximum=100000 ' +
                   `aggregate-restore=${Config.AggregateSpeedLimit} ` +
                   'aggregate-maximum=200000 ' +
                   'initial-bucket-level=90');
        cfg.custom('response_delay_pool_access slowPool allow slowResponse');
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
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        testCase.server().response.header.add("Speed", Config.Speed);

        testCase.addMissCheck();
        testCase.check(() => {
            testCase.expectStatusCode(200);

            const startDate = testCase.server().transaction().startTime();
            const endDate = testCase.client().transaction().receivedEverythingTime();

            const elapsedSec = (endDate.getTime() - startDate.getTime()) / 1000.0;
            console.log("Transaction took " + elapsedSec.toFixed(1) + "s");
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
