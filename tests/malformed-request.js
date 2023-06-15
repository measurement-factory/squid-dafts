// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests handling of requests that trigger immediate syntax or similar
// validation errors. Currently focuses on cases handled at the top of
// Http::One::Server::buildHttpRequest().

import * as Config from "../src/misc/Config";
import * as Gadgets from "../src/misc/Gadgets";
import Authority from "../src/anyp/Authority";
import HttpTestCase from "../src/test/HttpCase";
import Test from "../src/overlord/Test";

export default class MyTest extends Test {

    constructor() {
        super(...arguments);

        this._lastAccessRecord = null; // cached by check() in _configureTestCase()
    }

    async testHugeUrl() {
        const testCase = new HttpTestCase('huge URL');
        this._configureTestCase(testCase);

        const maxUriLength = 64*1024-1; // squid/Http::One::RequestParser::parseUriField()
        testCase.client().request.startLine.uri.path = Gadgets.RandomText("/long-path-", maxUriLength + 1);

        testCase.check(() => {
            testCase.expectStatusCode(414);
            this._lastAccessRecord.checkEqual('%>Hs', '414');
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_TOO_BIG');
            this._lastAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    async testBannedMethod() {
        const testCase = new HttpTestCase('banned HTTP method');
        this._configureTestCase(testCase);

        testCase.client().request.startLine.method = 'PRI';

        testCase.check(() => {
            testCase.expectStatusCode(405);
            this._lastAccessRecord.checkEqual('%>Hs', '405');
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_UNSUP_REQ');
            this._lastAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    async testBadMethod() {
        const testCase = new HttpTestCase('bad HTTP method');
        this._configureTestCase(testCase);

        // comma is not a TCHAR
        testCase.client().request.startLine.method = ',BAD,';

        testCase.check(() => {
            testCase.expectStatusCode(400);
            this._lastAccessRecord.checkEqual('%>Hs', '400');
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_PROTOCOL_UNKNOWN');
            this._lastAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    async testProtocolVersionTooSmall() {
        const testCase = new HttpTestCase('unreasonably small protocol version');
        this._configureTestCase(testCase);

        testCase.client().request.startLine.protocol = 'HTTP/0.1';

        testCase.check(() => {
            testCase.expectStatusCode(505);
            this._lastAccessRecord.checkEqual('%>Hs', '505');
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_UNSUP_HTTPVERSION');
            this._lastAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    async testProtocolVersionTooBig() {
        const testCase = new HttpTestCase('protocol version exceeding supported one');
        this._configureTestCase(testCase);

        testCase.client().request.startLine.protocol = 'HTTP/9.0';

        testCase.check(() => {
            testCase.expectStatusCode(505);
            this._lastAccessRecord.checkEqual('%>Hs', '505');
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_UNSUP_HTTPVERSION');
            this._lastAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    async testRelativeUrl() {
        const testCase = new HttpTestCase('relative URL');
        this._configureTestCase(testCase);

        testCase.client().request.startLine.uri.relative = true;
        // XXX: Work around Daft's "Cannot read properties of null (reading
        // 'raw')" error in Transaction::finalizeMessage(). TODO: Should
        // relative URIs have authority property set (as that code requires)?
        testCase.client().request.startLine.uri.authority = Authority.FromHostPort(Config.OriginAuthority);

        testCase.check(() => {
            testCase.expectStatusCode(400);
            this._lastAccessRecord.checkEqual('%>Hs', '400');
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_INVALID_URL');
            this._lastAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    // HttpTestCase configuration shared among all test cases
    _configureTestCase(testCase) {
        testCase.check(async () => {

            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            // TODO: When Squid logs these correctly
            // accessRecord.checkEqual('%Ss', 'TCP_...');
            // accessRecord.checkEqual('%rm', ...);
            accessRecord.checkUnknown('%<a');
            accessRecord.checkEqual('%Sh', 'HIER_NONE');
            this._lastAccessRecord = accessRecord;
        });
    }

    async run(/*testRun*/) {
        await this.testHugeUrl();
        await this.testBadMethod();
        await this.testRelativeUrl();

        // TODO: When Squid stops seeing another request after the bad one:
        // test> New transactions logged by the proxy: 2
        // test> Error: expecting a single access record but got 2.
        // await this.testProtocolVersionTooSmall();
        // await this.testProtocolVersionTooBig();

        this.dut.ignoreProblems(/\bPRI\b/);
        await this.testBannedMethod();
    }
}
