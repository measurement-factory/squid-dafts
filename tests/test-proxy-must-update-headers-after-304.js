// Proxy MUST update previously cached headers on 304 responses.
//
// mocha --bail --require tests/mocha-config tests/test-...

import Promise from "bluebird";
import ProxyCase from "./ProxyCase";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import assert from "assert";

process.on("unhandledRejection", function(reason /*, promise */) {
    console.log("Quitting on a rejected promise:", reason);
    throw reason;
});
Promise.config({warnings: true});

Config.DefaultMessageBodyContent = Array(2*32*1024).join("x");

const RequestUriPath = Gadgets.UniqueId("/path");

const Hour = new Date(60*60*1000).valueOf(); // 1 hour delta

const StartDate = new Date();
const FirstCreationDate = new Date(StartDate.valueOf() - 100*Hour);
const FirstExpirationDate = new Date(StartDate.valueOf() + Hour);
const DateFor304 = new Date(FirstCreationDate.valueOf() + Hour);
const DateFor200 = new Date(FirstCreationDate.valueOf() - Hour);
let SecondCreationDate = null; // TBD
let SecondExpirationDate = null; // TBD

let steps = [

() => {
    let testCase = new ProxyCase('forward a cachable response');
    testCase.client().request.startLine.uri._rest = RequestUriPath; // XXX: _rest
    testCase.server().response.header.add("Response-ID", "first");
    testCase.server().response.header.add("Last-Modified", FirstCreationDate.toUTCString());
    testCase.server().response.header.add("Expires", FirstExpirationDate.toUTCString());
    return testCase;
},

() => {
    let testCase = new ProxyCase('respond with a 304 hit');
    testCase.client().request.startLine.uri._rest = RequestUriPath; // XXX: _rest
    testCase.client().request.header.add("If-Modified-Since", DateFor304.toUTCString());
    testCase.check(() => {
        testCase.expectStatusCode(304);
    });
    return testCase;
},

() => {
    let testCase = new ProxyCase('miss and get a 304 that updates the previously cached response');

    SecondCreationDate = new Date();
    SecondExpirationDate = new Date(SecondCreationDate.valueOf() + Hour);

    testCase.client().request.startLine.uri._rest = RequestUriPath; // XXX: _rest
    testCase.client().request.header.add("If-Modified-Since", DateFor200.toUTCString());
    testCase.client().request.header.add("Cache-Control", "max-age=0");
    testCase.server().response.startLine.statusCode = 304;
    testCase.server().response.header.add("Response-ID", "second");
    testCase.server().response.header.add("Last-Modified", SecondCreationDate.toUTCString());
    testCase.server().response.header.add("Expires", SecondExpirationDate.toUTCString());

    testCase.check(() => {
        testCase.expectStatusCode(200);
        // XXX: Check the headers.
    });

    return testCase;
},

() => {
    let testCase = new ProxyCase('hit updated headers');
    testCase.client().request.startLine.uri._rest = RequestUriPath; // XXX: _rest
    testCase.check(() => {
        testCase.expectStatusCode(200);
        let response = testCase.client().transaction().response;
        assert.equal(response.header.values("Response-ID"), "second", "updated Response-ID");
        assert.equal(response.header.values("Last-Modified"), SecondCreationDate.toUTCString(), "updated Last-Modified");
        assert.equal(response.header.values("Expires"), SecondExpirationDate.toUTCString(), "updated Expires");
    });
    return testCase;
}

];

describe('proxy', function () {
    it('MUST update previously cached headers on 304 responses', async function () {
        await Promise.each(steps, step => step().run());
    });
});
