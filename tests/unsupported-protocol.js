// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests "on_unsupported_protocol tunnel" functionality. Currently requires:
// * Squid code hacks to treat regular http_port requests as intercepted ones;
// * http-param-server.pl as the server (this item should be easy to remove);
// * an external ACL script (this item should be easy to provide if we do
//   not test whether the helper receives correct %>handshake bytes.

import * as Config from "../src/misc/Config";
import * as Gadgets from "../src/misc/Gadgets";
import Authority from "../src/anyp/Authority";
import HttpTestCase from "../src/test/HttpCase";
import Test from "../src/overlord/Test";

import assert from "assert";

export default class MyTest extends Test {

    constructor() {
        super(...arguments);

        // This is the record test cases should check for case-specific
        // details. It is cached by check() in _configureTestCase().
        this._primeAccessRecord = null;
    }

    _configureDut(cfg) {
        cfg.custom(`
            external_acl_type alwaysOkHelper \
                concurrency=0 children-max=2 ttl=60 \
                %sn %master_xaction %>handshake \
                /usr/local/squid/bin/external_ok.sh
            acl shouldBeTunneled external alwaysOkHelper
        `);
        cfg.custom(`on_unsupported_protocol tunnel shouldBeTunneled`);
    }

    async testProtocolVersionTooSmall() {
        const testCase = new HttpTestCase('unreasonably small protocol version');
        this._configureTestCase(testCase);

        testCase.client().request.startLine.protocol = 'HTTP/0.1';

        testCase.check(() => {
            testCase.expectStatusCode(200); // successfully tunneled
            this._primeAccessRecord.checkEqual('%>Hs', '200');
            //this._primeAccessRecord.checkEqual('%err_code', 'ERR_UNSUP_HTTPVERSION');
            this._primeAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    async testProtocolVersionTooBig() {
        const testCase = new HttpTestCase('protocol version exceeding supported one');
        this._configureTestCase(testCase);

        testCase.client().request.startLine.protocol = 'HTTP/9.0';

        testCase.check(() => {
            testCase.expectStatusCode(200); // successfully tunneled
            this._primeAccessRecord.checkEqual('%>Hs', '200');
            //this._primeAccessRecord.checkEqual('%err_code', 'ERR_UNSUP_HTTPVERSION');
            this._primeAccessRecord.checkUnknown('%err_detail');
        });

        await testCase.run();
    }

    // HttpTestCase configuration shared among all test cases
    _configureTestCase(testCase) {
        testCase.check(async () => {

            const accessRecords = await this.dut.getNewAccessRecords();
            assert.strictEqual(accessRecords.count(), 2);
            const firstRecord = accessRecords.first();
            const lastRecord = accessRecords.last();

            // These are not necessarily "correct" values, but they are what
            // we _expect_ from current Squids.

            firstRecord.checkKnown('%>a');
            firstRecord.checkUnknown('%<a');
            firstRecord.checkEqual('%Sh', 'HIER_NONE');

            lastRecord.checkKnown('%>a');
            lastRecord.checkKnown('%<a');
            lastRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            // This test does not work in v5-based code that logs "-"
            // lastRecord.checkEqual('%rm', 'CONNECT');

            this._primeAccessRecord = lastRecord;
        });
    }

    async run(/*testRun*/) {
        await this.testProtocolVersionTooSmall();
        await this.testProtocolVersionTooBig();
    }
}
