/* Daft Toolkit                         http://www.measurement-factory.com/
 * Copyright (C) 2015,2016 The Measurement Factory.
 * Licensed under the Apache License, Version 2.0.                       */

// Proxy MUST update previously cached headers on 304 responses.

import HttpTestCase from "../src/test/HttpCase";
import Field from "../src/http/Field";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as AddressPool from "../src/misc/AddressPool";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import assert from "assert";
import Test from "../src/test/Test";
import { DutConfig, ProxyOverlord } from "../src/overlord/Proxy";


Config.Recognize([
    {
        option: "workers",
        type: "Number",
        default: "4",
        description: "the number of proxy SMP workers",
    },
]);


// TODO: Optionally tolerate any misses (mostly useful for parallel/life tests).

export default class MyTest extends Test {
    constructor(...args) {
        const cfg = new DutConfig();

        cfg.workers(Config.Workers);
        cfg.dedicatedWorkerPorts(true);

        // TODO: Make configurable, trying all three sensible combinations by default.
        // TODO: Try all three sensible combinations (by default).
        cfg.memoryCaching(false);
        cfg.diskCaching(true);

        super(new ProxyOverlord(cfg), ...args);

        this._workerListeningAddresses = cfg.workerListeningAddresses();
    }

    async run(/*testRun*/) {
        // XXX: unconditional this._workerListeningAddresses[3] access below
        assert(Config.Workers >= 3);

        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.modifiedAt(FuzzyTime.DistantPast());
        resource.expireAt(FuzzyTime.Soon());
        resource.body = new Body("x".repeat(7));
        resource.finalize();

        // This header appears in the initially cached response.
        // This header does not appear in the updatingResponse.
        // This header must appear in the updatedResponse.
        const hitCheck = new Field("X-Daft-Hit-Check", Gadgets.UniqueId("check"));

        // This header starts small in the initially cached response
        // but becomes large in the updatingResponse.
        let growingHeader = new Field("X-Daft-Growing", "small");

        {
            let testCase = new HttpTestCase('forward a cachable response');

            testCase.client().nextHopAddress = this._workerListeningAddresses[1];
            testCase.client().request.for(resource);

            testCase.server().serve(resource);
            testCase.server().response.tag("first");
            testCase.server().response.header.add(hitCheck);
            testCase.server().response.header.add(growingHeader);

            testCase.server().response.header.addWarning(199, "MUST be removed");
            testCase.server().response.header.addWarning(299, "MUST be preserved");

            testCase.check(() => {
                testCase.expectStatusCode(200);
                const receivedResponse = testCase.client().transaction().response;
                assert(receivedResponse.header.hasWarning(199), "DUT forwarded an 1xx Warning");
                assert(receivedResponse.header.hasWarning(299), "DUT forwarded a 2xx Warning");
            });

            await testCase.run();
        }

        {
            let testCase = new HttpTestCase('check that the response was cached');

            testCase.client().nextHopAddress = this._workerListeningAddresses[1];
            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.notModifiedSince() });

            testCase.check(() => {
                testCase.expectStatusCode(304);
                const receivedResponse = testCase.client().transaction().response;
                assert(!receivedResponse.header.hasWarning(199), "DUT did not generate an 1xx Warning");
                assert(!receivedResponse.header.hasWarning(299), "DUT did not generate a 2xx Warning");
            });
            await testCase.run();
        }

        let updatingResponse = null; // TBD
        {
            let testCase = new HttpTestCase('force a 304 miss that updates the previously cached response');

            resource.modifyNow();
            resource.expireAt(FuzzyTime.DistantFuture());

            growingHeader.value = "la" + "A".repeat(100) + "rge";

            testCase.client().nextHopAddress = this._workerListeningAddresses[2];
            testCase.client().request.for(resource);
            testCase.client().request.conditions({ ims: resource.modifiedSince() });
            testCase.client().request.header.add("Cache-Control", "max-age=0");

            testCase.server().serve(resource);
            testCase.server().response.tag("second");
            testCase.server().response.startLine.statusCode = 304;
            testCase.server().response.header.add(growingHeader);

            testCase.check(() => {
                testCase.expectStatusCode(200);
                updatingResponse = testCase.server().transaction().response;
                const receivedResponse = testCase.client().transaction().response;
                assert.equal(updatingResponse.tag(), receivedResponse.tag(), "relayed X-Daft-Response-Tag");
                assert.equal(updatingResponse.id(), receivedResponse.id(), "relayed X-Daft-Response-ID");
                assert.equal(receivedResponse.header.values("Last-Modified"), resource.lastModificationTime.toUTCString(), "relayed Last-Modified");
                assert.equal(receivedResponse.header.values("Expires"), resource.nextModificationTime.toUTCString(), "relayed Expires");
                assert.equal(receivedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
                assert(!receivedResponse.header.hasWarning(199), "304 did not restore a 1xx Warning");
                assert(receivedResponse.header.hasWarning(299), "304 preserved a 2xx Warning");
            });

            await testCase.run();
        }

        {
            let testCase = new HttpTestCase('check whether the cached headers got updated');

            testCase.client().nextHopAddress = this._workerListeningAddresses[3];
            testCase.client().request.for(resource);

            testCase.check(() => {
                testCase.expectStatusCode(200);
                let updatedResponse = testCase.client().transaction().response;
                assert.equal(updatedResponse.tag(), updatingResponse.tag(), "updated X-Daft-Response-Tag");
                assert.equal(updatedResponse.id(), updatingResponse.id(), "updated X-Daft-Response-ID");
                assert.equal(updatedResponse.header.values("Last-Modified"), resource.lastModificationTime.toUTCString(), "updated Last-Modified");
                assert.equal(updatedResponse.header.values("Expires"), resource.nextModificationTime.toUTCString(), "updated Expires");
                assert.equal(updatedResponse.header.value(hitCheck.name), hitCheck.value, "preserved originally cached header field");
                assert(!updatedResponse.header.hasWarning(199), "200 did not restore an 1xx Warning");
                assert(updatedResponse.header.hasWarning(299), "200 preserved a 2xx Warning");
            });

            await testCase.run();
        }

        {
            // With the right cache size, this test case forces the DUT to reuse
            // old (and now freed) index entries _and_ flush them to disk.
            // Without it, restarting the proxy after the test may bring old
            // entries back or produce other confusing results. TODO: We should
            // actually restart the DUT to check that it has flushed its state.
            // It is not clear whether that should be done in this test though.
            let testCase = new HttpTestCase('cleanup leftovers using a cachable response');
            resource.uri.makeUnique();

            testCase.client().nextHopAddress = this._workerListeningAddresses[1];
            testCase.client().request.for(resource);
            testCase.client().request.tag("cleanup");

            testCase.server().serve(resource);
            testCase.server().response.tag("cleanup");
            await testCase.run();
        }

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

}
