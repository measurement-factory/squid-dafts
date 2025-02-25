// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Checks whether smooth reconfiguration of cache_peers works.

import assert from "assert";

import * as Config from "../src/misc/Config";
import * as CachePeer from "../src/overlord/CachePeer";
import HttpTestCase from "../src/test/HttpCase";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.dutCachePeers(function *() {
            yield 2;
        });

        return configGen.generateConfigurators();
    }

    constructor() {
        super(...arguments);

        this._lastAccessRecord = null; // cached by check() in _makeTestCase()
    }

    _configureDut(cfg) {
        assert(cfg.cachePeers().length >= 2);
        const cachePeerA = cfg.cachePeers()[0];
        const cachePeerB = cfg.cachePeers()[1];

        cachePeerA.setName("peerA");
        cachePeerB.setName("peerB");

        // TODO: Can the same test work for harsh reconfiguration?
        cfg.custom("reconfiguration smooth");
    }

    // HttpTestCase configuration shared among all test cases
    _makeTestCase(requestMethod, goal, cachePeer) {
        const testCase = new HttpTestCase(`${goal}; ${requestMethod} to cache_peer name=${cachePeer.config().name()}`);

        testCase.client().request.startLine.method = requestMethod;
        testCase.client().request.startLine.uri.address = {
            host: Config.originAuthority().host,
            // use default (privileged) ports because we use no origin server
            port: (requestMethod === "CONNECT" ? 443 : 80),
        };

        // we do not need a server because all traffic goes through
        // cache_peers that generate (i.e. do not forward) responses

        cachePeer.config().attract(testCase.client().request);

        testCase.check(async () => {
            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkEqual('%rm', requestMethod);
            accessRecord.checkKnown('%>a');
            this._lastAccessRecord = accessRecord;
        });

        if (cachePeer.config().hidden()) {
            testCase.check(async () => {
                testCase.expectStatusCode(502);

                this._lastAccessRecord.checkEqual('%err_code', 'ERR_READ_ERROR');
                this._lastAccessRecord.checkKnown('%err_detail');
                this._lastAccessRecord.checkUnknown('%<Hs');
                this._lastAccessRecord.checkEqual('%>Hs', '502');
                this._lastAccessRecord.checkEqual('%Sh', 'HIER_NONE');
                this._lastAccessRecord.checkUnknown('%<a');
            });
        } else {
            testCase.check(async () => {
                testCase.expectStatusCode(200);
                testCase.client().transaction().response.header.expectFieldValueAmongOthers(cachePeer.response.header.has("Via"));

                this._lastAccessRecord.checkUnknown('%err_code');
                this._lastAccessRecord.checkUnknown('%err_detail');
                this._lastAccessRecord.checkEqual('%>Hs', '200');
                this._lastAccessRecord.checkEqual('%<Hs', '200');
                this._lastAccessRecord.checkEqual('%Ss', 'TCP_MISS');
                this._lastAccessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
                this._lastAccessRecord.checkKnown('%<a');
            });
        }

        return testCase;
    }

    async run(/*testRun*/) {

        assert(this.dut.cachePeers().length >= 2);
        const cachePeerA = this.dut.cachePeers()[0];
        const cachePeerB = this.dut.cachePeers()[1];

        await this._makeTestCase('GET', 'peerA baseline', cachePeerA).run();
        await this._makeTestCase('GET', 'peerB baseline', cachePeerB).run();

        await this.dut.reconfigureWithoutChanges(true);
        await this._makeTestCase('GET', 'peerA routing after no-changes reconfiguration', cachePeerA).run();
        await this._makeTestCase('GET', 'peerB routing after no-changes reconfiguration', cachePeerB).run();

        // TODO: Resume honoring these problems (as needed) later.
        this.dut.ignoreProblems(/WARNING: Removing old cache_peer.*\bpeerA\b/);
        cachePeerA.config().hide("testing removal of the first cache_peer");
        await this.dut.reconfigureAfterChanges();
        await this._makeTestCase('GET', 'peerA routing after peerA removal', cachePeerA).run();
        await this._makeTestCase('GET', 'peerB routing after peerA removal', cachePeerB).run();

        this.dut.ignoreProblems(/WARNING: Removing old cache_peer.*\bpeerB\b/);
        cachePeerB.config().hide("testing removal of the last remaining cache_peer");
        await this.dut.reconfigureAfterChanges();
        await this._makeTestCase('GET', 'peerA routing after peerB removal', cachePeerA).run();
        await this._makeTestCase('GET', 'peerB routing after peerB removal', cachePeerB).run();

        cachePeerB.config().show();
        await this.dut.reconfigureAfterChanges();
        // TODO: Enable the case below after making cache_peer_access pliable:
        // Unchanged rigid cache_peer_access directives are ignored for added
        // cache_peers (e.g., peerB in this case that was re-added above).
        // await this._makeTestCase('GET', 'peerA routing after peerB resurrection', cachePeerA).run();
        await this._makeTestCase('GET', 'peerB routing after peerB resurrection', cachePeerB).run();
    }
}
