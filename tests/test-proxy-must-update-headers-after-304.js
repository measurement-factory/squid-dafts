// Proxy MUST update previously cached headers on 304 responses.
//
// mocha --compilers js:babel/register tests/test-...


import ProxyCase from "./ProxyCase";
import Client from "../src/client/Agent";
import Server from "../src/server/Agent";
import Request from "../src/http/Request";
import Response from "../src/http/Response";
import Body from "../src/http/Body";
import * as Gadgets from "../src/misc/Gadgets";
import * as Config from "../src/misc/Config";
import assert from "assert";

Config.DefaultMessageBodyContent = Array(2*32*1024).join("x");

const RequestUriPath = Gadgets.UniqueId("/path");

const Second = new Date(1000).valueOf(); // 1 second delta
const Hour = new Date(60*60*1000).valueOf(); // 1 hour delta

const StartDate = new Date();
const FirstCreationDate = new Date(StartDate.valueOf() - 100*Hour);
const FirstExpirationDate = new Date(StartDate.valueOf() + Hour);
const DateFor304 = new Date(FirstCreationDate.valueOf() + Hour);
const DateFor200 = new Date(FirstCreationDate.valueOf() - Hour);
let SecondCreationDate = undefined; // TBD
let SecondExpirationDate = undefined; // TBD

describe('proxy', function () {

    let testCase = new ProxyCase(true, true);

    before('start server', function (done) {
        testCase.startServer(done);
    });

    it('should forward a cachable response', function (done) {
        testCase.client.agent.request.startLine.uri._rest = RequestUriPath; // XXX: _rest
        testCase.server.agent.response.header.add("Response-ID", "first");
        testCase.server.agent.response.header.add("Last-Modified", FirstCreationDate.toUTCString());
        testCase.server.agent.response.header.add("Expires", FirstExpirationDate.toUTCString());
        testCase.startClient();
        testCase.run(done);
    });

    after('stop agents', function (done) {
        testCase.stopAgents(done);
    });
});

describe('proxy', function () {

    let testCase = new ProxyCase(true, false);

    it('should respond with a 304 hit', function (done) {
        testCase.client.agent.request.startLine.uri._rest = RequestUriPath; // XXX: _rest
        testCase.client.agent.request.header.add("If-Modified-Since", DateFor304.toUTCString());

        testCase.check(() => {
            testCase.expectStatusCode(304);
        });

        testCase.startClient();
        testCase.run(done);
    });

    after('stop agents', function (done) {
        testCase.stopAgents(done);
    });
});

// max-age=0 trick makes sleeping unnecessary
// describe('proxy', function () {
//     it('should wait for the cached response to become stale', function (done) {
//         this.timeout(5*Second);
//         setTimeout(() => { done(); }, 2*Second);
//     });
// });

describe('proxy', function () {

    let testCase = new ProxyCase(true, true);

    before('start server', function (done) {
        testCase.startServer(done);
    });

    it('should miss, get 304, and update the previously cached response', function (done) {
        SecondCreationDate = new Date();
        SecondExpirationDate = new Date(SecondCreationDate.valueOf() + Hour);

        testCase.client.agent.request.startLine.uri._rest = RequestUriPath; // XXX: _rest
        testCase.client.agent.request.header.add("If-Modified-Since", DateFor200.toUTCString());
        testCase.client.agent.request.header.add("Cache-Control", "max-age=0");
        testCase.server.agent.response.startLine.statusCode = 304;
        testCase.server.agent.response.header.add("Response-ID", "second");
        testCase.server.agent.response.header.add("Last-Modified", SecondCreationDate.toUTCString());
        testCase.server.agent.response.header.add("Expires", SecondExpirationDate.toUTCString());

        testCase.check(() => {
            testCase.expectStatusCode(200);
            // XXX: Check the headers.
        });

        testCase.startClient();
        testCase.run(done);
    });

    after('stop agents', function (done) {
        testCase.stopAgents(done);
    });
});

describe('proxy', function () {

    let testCase = new ProxyCase(true, false);

    it('should hit updated headers', function (done) {
        testCase.client.agent.request.startLine.uri._rest = RequestUriPath; // XXX: _rest
        testCase.check(() => {
            testCase.expectStatusCode(200);
            assert.equal(testCase.client.transaction.response.header.values("Response-ID"), "second", "updated Response-ID");
            assert.equal(testCase.client.transaction.response.header.values("Last-Modified"), SecondCreationDate.toUTCString(), "updated Last-Modified");
            assert.equal(testCase.client.transaction.response.header.values("Expires"), SecondExpirationDate.toUTCString(), "updated Expires");
        });
        testCase.startClient();
        testCase.run(done);
    });

    after('stop agents', function (done) {
        testCase.stopAgents(done);
    });
});
