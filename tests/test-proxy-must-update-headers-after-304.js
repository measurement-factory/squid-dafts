/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

// Proxy MUST update previously cached headers on 304 responses.

import Promise from "bluebird";
import ProxyCase from "./ProxyCase";
import Field from "../src/http/Field";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import StartTests from "../src/misc/TestRunner";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Gadgets from "../src/misc/Gadgets";
import assert from "assert";

process.on("unhandledRejection", function (reason /*, promise */) {
    console.log("Quitting on a rejected promise:", reason);
    throw reason;
});
Promise.config({ warnings: true });

// TODO: Optionally tolerate any misses (mostly useful for parallel/life tests).

async function Test(testRun, callback) {

    let resource = new Resource();
    resource.uri.address = Gadgets.ReserveListeningAddress();
    resource.modifiedAt(FuzzyTime.DistantPast());
    resource.expireAt(FuzzyTime.Soon());
    resource.body = new Body("x".repeat(64*1024));
    resource.finalize();

    // This header appears in the initially cached response.
    // This header does not appear in the updatingResponse.
    // This header must upppear in the updatedResponse.
    const hitCheck = new Field("X-Daft-Hit-Check", Gadgets.UniqueId("check"));

    {
        let testCase = new ProxyCase('forward a cachable response');
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        testCase.server().response.tag("first");
        testCase.server().response.header.add(hitCheck);
        await testCase.run();
    }

    {
        let testCase = new ProxyCase('respond with a 304 hit');
        testCase.client().request.for(resource);
        testCase.client().request.conditions({ ims: resource.notModifiedSince() });
        testCase.check(() => {
            testCase.expectStatusCode(304);
        });
        await testCase.run();
    }

    let updatingResponse = null; // TBD
    {
        let testCase = new ProxyCase('miss and get a 304 that updates the previously cached response');

        resource.modifyNow();
        resource.expireAt(FuzzyTime.DistantFuture());

        testCase.client().request.for(resource);
        testCase.client().request.conditions({ ims: resource.modifiedSince() });
        testCase.client().request.header.add("Cache-Control", "max-age=0");

        testCase.server().serve(resource);
        testCase.server().response.tag("second");
        testCase.server().response.startLine.statusCode = 304;

        testCase.check(() => {
            testCase.expectStatusCode(200);
            // XXX: Check the headers.
            updatingResponse = testCase.server().transaction().response;
        });

        await testCase.run();
    }

    {
        let testCase = new ProxyCase('hit updated headers');
        testCase.client().request.for(resource);
        testCase.check(() => {
            testCase.expectStatusCode(200);
            let updatedResponse = testCase.client().transaction().response;
            assert.equal(updatedResponse.tag(), updatingResponse.tag(), "updated X-Daft-Response-Tag");
            assert.equal(updatedResponse.id(), updatingResponse.id(), "updated X-Daft-Response-ID");
            assert.equal(updatedResponse.header.values("Last-Modified"), resource.lastModificationTime.toUTCString(), "updated Last-Modified");
            assert.equal(updatedResponse.header.values("Expires"), resource.nextModificationTime.toUTCString(), "updated Expires");
            assert.equal(updatedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
        });
        await testCase.run();
    }

    {
        let testCase = new ProxyCase('cleanup leftovers using a cachable response');
        resource.uri.makeUnique();
        testCase.client().request.for(resource);
        testCase.client().request.tag("cleanup");
        testCase.server().serve(resource);
        testCase.server().response.tag("cleanup");
        await testCase.run();
    }

    Gadgets.ReleaseListeningAddress(resource.uri.address);
    console.log("Test result: success");
    if (callback)
        callback();
}

StartTests(Test);
