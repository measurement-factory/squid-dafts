// Proxy MUST update previously cached headers on 304 responses.
//
// mocha --bail --require tests/mocha-config tests/test-...

import Promise from "bluebird";
import ProxyCase from "./ProxyCase";
import * as Config from "../src/misc/Config";
import * as Uri from "../src/anyp/Uri";
import Resource from "../src/anyp/Resource";
import * as FuzzyTime from "../src/misc/FuzzyTime";
import assert from "assert";

process.on("unhandledRejection", function (reason /*, promise */) {
    console.log("Quitting on a rejected promise:", reason);
    throw reason;
});
Promise.config({ warnings: true });

Config.DefaultMessageBodyContent = Array(2*32*1024).join("x");

const Hour = new Date(60*60*1000); // 1 hour delta

// TODO: Optionally tolerate any misses (mostly useful for parallel/life tests).

let resource = new Resource();
resource.uri = Uri.Unique();
resource.modifiedAt(FuzzyTime.DistantPast());
resource.expireAt(FuzzyTime.Soon());

let UpdatingResponse = null; // TBD

let steps = [

    () => {
        let testCase = new ProxyCase('forward a cachable response');
        testCase.client().request.for(resource);
        testCase.server().serve(resource);
        testCase.server().response.tag("first");
        return testCase;
    },

    () => {
        let testCase = new ProxyCase('respond with a 304 hit');
        testCase.client().request.for(resource);
        testCase.client().request.conditions({ ims: resource.notModifiedSince(Hour) });
        testCase.check(() => {
            testCase.expectStatusCode(304);
        });
        return testCase;
    },

    () => {
        let testCase = new ProxyCase('miss and get a 304 that updates the previously cached response');

        resource.modifyNow();
        resource.expireAt(FuzzyTime.DistantFuture());
        testCase.client().request.for(resource);
        testCase.client().request.conditions({ ims: resource.modifiedSince(Hour) });
        testCase.client().request.header.add("Cache-Control", "max-age=0");
        testCase.server().serve(resource);
        testCase.server().response.tag("second");
        testCase.server().response.startLine.statusCode = 304;
        testCase.check(() => {
            testCase.expectStatusCode(200);
            // XXX: Check the headers.
            UpdatingResponse = testCase.server().transaction().response;
        });

        return testCase;
    },

    () => {
        let testCase = new ProxyCase('hit updated headers');
        testCase.client().request.for(resource);
        testCase.check(() => {
            testCase.expectStatusCode(200);
            let updatedResponse = testCase.client().transaction().response;
            assert.equal(updatedResponse.tag(), UpdatingResponse.tag(), "updated X-Daft-Response-Tag");
            assert.equal(updatedResponse.id(), UpdatingResponse.id(), "updated X-Daft-Response-ID");
            assert.equal(updatedResponse.header.values("Last-Modified"), resource.lastModificationTime.toUTCString(), "updated Last-Modified");
            assert.equal(updatedResponse.header.values("Expires"), resource.nextModificationTime.toUTCString(), "updated Expires");
        });
        return testCase;
    }

];

describe('proxy', function () {
    it('MUST update previously cached headers on 304 responses', async function () {
        await Promise.each(steps, step => step().run());
    });
});
