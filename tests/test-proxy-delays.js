/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

// Check whether proxy-introduced delays match proxy configuration.
// The current focus is on Squid's response_delay_pool directive.

// Expected Squid response delay pool configuration:
//
// acl slowResponse urlpath_regex ^/speed=slow/
// response_delay_pool slowPool \
//     bucket_speed_limit=50000 \
//     max_bucket_size=100000 \
//     aggregate_speed_limit=100000 \
//     max_aggregate_size=200000 \
//     initial_fill_level=90
// response_delay_pool_access slowPool allow slowResponse


import Promise from "bluebird";
import ProxyCase from "./ProxyCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as Http from "../src/http/Gadgets";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import StartTests from "../src/misc/TestRunner";
import assert from "assert";

process.on("unhandledRejection", function (reason /*, promise */) {
    console.log("Quitting on a rejected promise:", reason);
    throw reason;
});
Promise.config({ warnings: true });

Config.Recognize([
    {
        option: "speed",
        type: "String",
        enum: [ "fast", "slow" ],
        default: "slow",
        description: "expected response speed",
    },
]);

const bucketSpeed = 50 * 1000;
const aggregateSpeed = bucketSpeed * 2;
const srvBodySize = 1000 * 1000; // 1 MB
const maxDeviation = 10.0; // percent

async function Test(testRun, callback) {

    // do not log large body handling details by default
    if (Config.LogBodies === undefined)
        Config.LogBodies = 0;

    let slowSpeed = aggregateSpeed / Config.ConcurrencyLevel;
    if (slowSpeed > bucketSpeed)
        slowSpeed = bucketSpeed;

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
    resource.uri.address = Gadgets.ReserveListeningAddress();
    resource.uri.makeUnique("/speed=" + Config.Speed + "/");
    resource.body = new Body("x".repeat(srvBodySize));
    resource.uri.makeUnique("/speed=" + Config.Speed + "/");
    // XXX: We should mark the response, not the request [URI].

    let testCase = new ProxyCase(description);
    testCase.client().request.for(resource);
    testCase.server().serve(resource);
    testCase.server().response.header.add("Speed", Config.Speed);

    // XXX: startDate and endDate should be reported by transactions and
    // renamed to startTime() and stopTime().
    const startDate = new Date();
    testCase.check(() => {
        const endDate = new Date();

        testCase.expectStatusCode(200);
        Http.AssertForwardedMessage(testCase.server().transaction().response,
            testCase.client().transaction().response, "forwarded response");

        const elapsedSec = (endDate.getTime() - startDate.getTime()) / 1000.0;
        console.log("Transaction took " + elapsedSec.toFixed(1) + "s");
        const speed = srvBodySize / elapsedSec;
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

    console.log("Test result: success");
    if (callback)
        callback();
}

StartTests(Test);