// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Check whether the proxy rejects responses with truncated headers. Check
// whether the proxy preserves body truncation signals when forwarding
// truncated response bodies (and does not cache such truncated responses).
// Response truncation may be caused either by the server (that closes its
// connection prematurely) or by the proxy itself (when it prematurely
// declares a read timeout).

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import ConfigGen from "../src/test/ConfigGen";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";

import assert from "assert";

// all the supported ways to truncate a to-proxy response
const TruncationWays = [
    "header1", "header2", "header3", "header4",
    "body1", "body2", "body3", "body4", "body5"
];

Config.Recognize([
    {
        option: "truncation-way",
        type: "String",
        enum: TruncationWays,
        description: "where and how the response is truncated",
    },
]);

export default class MyTest extends Test {

    constructor() {
        super();
        this.resource = null; // shared by primary and secondary test cases
    }

    static Configurators() {
        const configGen = new ConfigGen();
        configGen.addGlobalConfigVariation({truncationWay: TruncationWays});
        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        cfg.memoryCaching(true); // TODO: Make Configurable.
        cfg.diskCaching(true); // TODO: Make Configurable.

        // We do not want to waste the default 15 minutes on waiting for the
        // proxy to timeout (while the proxy waits for the completion of our
        // server response). Technically, this customization is only needed
        // for closeLast() tests, but we cannot easily identify just those.
        if (Config.TruncationWay.startsWith("body"))
            cfg.custom(`read_timeout 2 seconds`);
    }

    async testTruncatedHeader(statusCode, contentLength) {
        this.dut.ignoreProblems(new RegExp("Invalid Response"));

        let testCase = new HttpTestCase(`check that proxy rejects a response with truncated header (status=${statusCode},contentLength=${contentLength})`);

        testCase.client().request.for(this.resource);

        testCase.server().serve(this.resource);
        testCase.server().response.startLine.code(statusCode);
        testCase.server().response.headerDelimiter = "";
        if (contentLength != -1)
            testCase.server().response.header.add("Content-Length", contentLength);
        else
            testCase.server().response.header.prohibitNamed("Content-Length");

        testCase.check(() => {
            testCase.client().expectStatusCode(502);
        });

        await testCase.run();
    }

    makeBodyTestCase(desc) {
        let testCase = new HttpTestCase(`check that proxy sends an incomplete response with ${desc}`);
        testCase.client().request.for(this.resource);
        testCase.server().serve(this.resource);

        testCase.check(() => {
            testCase.client().expectStatusCode(200);

            const sentBody = testCase.server().transaction().response.body;
            const receivedBody = testCase.client().transaction().response.body;

             // the client received an incomplete body
            assert(!receivedBody.innedAll);

            // the client received every (decoded) body byte sent by the server
            assert.strictEqual(receivedBody.innedSize(), sentBody.outedSize());
        });

        return testCase;
    }

    // proxy times out waiting for response last-chunk
    async testChunkedProxyTimeout() {
        let testCase = this.makeBodyTestCase('a chunked body truncated by proxy timeout');
        let serverResponse = testCase.server().response;
        serverResponse.chunkBody("true");
        serverResponse.withholdLastChunk(true);
        testCase.server().transaction().closeLast('waiting for proxy to timeout');
        await testCase.run();
    }

    // proxy times out waiting for response EOF
    async testEofProxyTimeout() {
        let testCase = this.makeBodyTestCase('an eof-terminated body truncated by proxy timeout');
        let serverResponse = testCase.server().response;
        serverResponse.forceEof = true;
        serverResponse.body.withholdLastByte(true);
        testCase.server().transaction().closeLast('waiting for proxy to timeout');
        await testCase.run();
    }

    // proxy times out waiting for the last body byte
    async testKnownLengthProxyTimeout() {
        let testCase = this.makeBodyTestCase('a known-length body truncated by proxy timeout');
        let serverResponse = testCase.server().response;
        serverResponse.body.withholdLastByte(true);
        testCase.server().transaction().closeLast('waiting for proxy to timeout');
        await testCase.run();
    }

    // server disconnects before sending last-chunk
    async testChunkedServerDisconnected() {
        let testCase = this.makeBodyTestCase('a chunked body truncated by server');
        let serverResponse = testCase.server().response;
        serverResponse.chunkBody("true");
        serverResponse.withholdLastChunk(true);
        await testCase.run();
    }

    // server disconnects before sending the last body byte
    async testKnownLengthServerDisconnected() {
        let testCase = this.makeBodyTestCase('a known-length body truncated by server');
        let serverResponse = testCase.server().response;
        serverResponse.body.withholdLastByte(true);
        await testCase.run();
    }

    // after the primary test case succeeds, check that the proxy does not
    // serve the truncated response from the cache
    async testWhetherTruncatedResponseGotCached() {
        if (!this.dut.config().cachingEnabled())
            return;

        let missCase = new HttpTestCase(`try to hit the truncated response`);
        missCase.server().serve(this.resource);
        missCase.client().request.for(this.resource);
        missCase.addMissCheck();
        await this.dut.finishCaching();
        await missCase.run();
    }

    async run(/*testRun*/) {
        const originAddress = AddressPool.ReserveListeningAddress();

        this.resource = new Resource();
        this.resource.uri.address = originAddress;
        if (Config.TruncationWay.startsWith("header"))
            this.resource.body = null;
        this.resource.makeCachable();
        this.resource.finalize();

        // primary test case
        if (Config.TruncationWay === "header1")
            await this.testTruncatedHeader(200, Config.DefaultBodySize());
        else if (Config.TruncationWay === "header2")
            await this.testTruncatedHeader(200, 0);
        else if (Config.TruncationWay === "header3")
            await this.testTruncatedHeader(200, -1);
        else if (Config.TruncationWay === "header4")
            await this.testTruncatedHeader(304, -1);
        else if (Config.TruncationWay === "body1")
            await this.testChunkedProxyTimeout();
        else if (Config.TruncationWay === "body2")
            await this.testEofProxyTimeout();
        else if (Config.TruncationWay === "body3")
            await this.testKnownLengthProxyTimeout();
        else if (Config.TruncationWay === "body4")
            await this.testChunkedServerDisconnected();
        else if (Config.TruncationWay === "body5")
            await this.testKnownLengthServerDisconnected();
        else
            assert(false);

        // secondary test case
        await this.testWhetherTruncatedResponseGotCached();

        AddressPool.ReleaseListeningAddress(originAddress);
    }
}

