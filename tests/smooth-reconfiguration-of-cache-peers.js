// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Test smooth reconfiguration of cache_peer and cache_peer_access directives.

import { FlexibleConfigGen } from "../src/test/ConfigGen.js";
import * as CachePeer from "../src/overlord/CachePeer.js";
import assert from "assert";
import Config from "../src/misc/Config.js";
import HttpTestCase from "../src/test/HttpCase.js";
import Test from "../src/overlord/Test.js";

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.dutCachePeers(function *() {
            yield 2;
        });

        return configGen.generateConfigurators();
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
    _makeTestCase(goal, cachePeerToTarget, cachePeerThatShouldReceiveRequest = null) {
        if (!cachePeerThatShouldReceiveRequest)
            cachePeerThatShouldReceiveRequest = cachePeerToTarget;

        const testCase = new HttpTestCase(goal);

        const requestMethod = 'GET';
        testCase.client().request.startLine.method = requestMethod;
        testCase.client().request.startLine.uri.address = {
            host: Config.originAuthority().host,
            // use default (privileged) ports because we use no origin server
            port: (requestMethod === "CONNECT" ? 443 : 80),
        };

        // we do not need a server because all traffic goes through
        // cache_peers that generate (i.e. do not forward) responses

        cachePeerToTarget.config().attract(testCase.client().request);

        testCase.expectAccessRecordChecks(this.dut);

        testCase.check(() => {
            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkEqual('%rm', requestMethod);
            accessRecord.checkKnown('%>a');
        });

        if (cachePeerToTarget.config().hidden()) {
            testCase.check(() => {
                testCase.expectStatusCode(502);

                const accessRecord = testCase.accessRecords().single();
                accessRecord.checkEqual('%err_code', 'ERR_READ_ERROR');
                accessRecord.checkKnown('%err_detail');
                accessRecord.checkUnknown('%<Hs');
                accessRecord.checkEqual('%>Hs', '502');
                accessRecord.checkEqual('%Sh', 'HIER_NONE');
                accessRecord.checkUnknown('%<a');
            });
        } else {
            testCase.check(() => {
                testCase.expectStatusCode(200);
                testCase.client().transaction().response.header.expectFieldValueAmongOthers(cachePeerThatShouldReceiveRequest.response.header.has("Via"));

                const accessRecord = testCase.accessRecords().single();
                accessRecord.checkUnknown('%err_code');
                accessRecord.checkUnknown('%err_detail');
                accessRecord.checkEqual('%>Hs', '200');
                accessRecord.checkEqual('%<Hs', '200');
                accessRecord.checkEqual('%Ss', 'TCP_MISS');
                accessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
                accessRecord.checkKnown('%<a');
            });
        }

        return testCase;
    }

    async run(/*testRun*/) {

        assert(this.dut.cachePeers().length >= 2);
        const cachePeerA = this.dut.cachePeers()[0];
        const cachePeerB = this.dut.cachePeers()[1];

        await this._makeTestCase('peerA baseline', cachePeerA).run();
        await this._makeTestCase('peerB baseline', cachePeerB).run();

        await this.dut.reconfigureWithoutChanges(true);
        await this._makeTestCase('peerA routing after no-changes reconfiguration', cachePeerA).run();
        await this._makeTestCase('peerB routing after no-changes reconfiguration', cachePeerB).run();

        // TODO: Resume honoring these problems (as needed) later.
        this.dut.ignoreProblems(/WARNING: Removing old cache_peer.*\bpeerA\b/);
        cachePeerA.config().hide("testing removal of the first cache_peer");
        await this.dut.reconfigureAfterChanges();
        await this._makeTestCase('peerA routing after peerA removal', cachePeerA).run();
        await this._makeTestCase('peerB routing after peerA removal', cachePeerB).run();

        this.dut.ignoreProblems(/WARNING: Removing old cache_peer.*\bpeerB\b/);
        cachePeerB.config().hide("testing removal of the last remaining cache_peer");
        await this.dut.reconfigureAfterChanges();
        await this._makeTestCase('peerA routing after peerB removal', cachePeerA).run();
        await this._makeTestCase('peerB routing after peerB removal', cachePeerB).run();

        cachePeerB.config().show();
        await this.dut.reconfigureAfterChanges();
        await this._makeTestCase('peerA routing after peerB resurrection', cachePeerA).run();
        await this._makeTestCase('peerB routing after peerB resurrection', cachePeerB).run();

        cachePeerA.config().show();
        await this.dut.reconfigureAfterChanges();
        await this._makeTestCase('peerA routing after peerA resurrection', cachePeerA).run();
        await this._makeTestCase('peerB routing after peerA resurrection', cachePeerB).run();

        await this._runPconnCases(cachePeerA, cachePeerB); // enables pconns in both cache_peers

        // Test these last: No API to undo these squid.conf changes yet.
        cachePeerA.config().becomeAttractedToNone(); // only modifies cache_peer_access directives
        cachePeerB.config().becomeAttractedToAll(); // only modifies cache_peer_access directives
        await this.dut.reconfigureAfterChanges();
        await this._makeTestCase('re-routing from peerA to peerB via cache_peer_access mods', cachePeerA, cachePeerB).run();
    }

    async _runPconnCases(cachePeerA, cachePeerB) {

        cachePeerA.keepConnections();
        cachePeerB.keepConnections();

        const openCaseA = this._makeTestCase('create peerA pconns', cachePeerA);
        openCaseA.client().keepConnections();
        await openCaseA.run();

        const openCaseB = this._makeTestCase('create peerB pconns', cachePeerB);
        openCaseB.client().keepConnections();
        await openCaseB.run();

        const caseBeforeNoChangeA = this._makePconnReuseCase('peerA pconn reuse before no-change reconfiguration', cachePeerA, openCaseA, true);
        await caseBeforeNoChangeA.run();
        await this.dut.reconfigureWithoutChanges(true);
        const caseAfterNoChangeA = this._makePconnReuseCase('peerA pconn reuse after no-change reconfiguration', cachePeerA, caseBeforeNoChangeA, false);
        await caseAfterNoChangeA.run();

        cachePeerB.config().hide("testing peerA pconns across peerB removal+resurrection");
        await this.dut.reconfigureAfterChanges();
        cachePeerB.config().show();
        await this.dut.reconfigureAfterChanges();

        await this._makePconnReuseCase('peerA pconn reuse after peerB removal+resurrection', cachePeerA, caseAfterNoChangeA, false);
        await this._makePconnReuseCase('peerB pconn reuse after peerB removal+resurrection', cachePeerB, openCaseB, false);
    }

    // Creates a pconn reuse test case to validate the following expectations:
    // * expecting pconn reuse between client and DUT
    // * expectation of pconn reuse between DUT and cachePeer depends on the last parameter
    _makePconnReuseCase(goal, cachePeer, openCase, expectReuseWithCachePeer) {
        // keep in sync with run() in pconn.js

        const reuseCase = this._makeTestCase(goal, cachePeer);
        reuseCase.client().reuseConnectionsFrom(openCase.client());
        reuseCase.client().keepConnections();

        reuseCase.client().checks.add((client) => {
            assert.strictEqual(client.transaction().reusedTransportConnection(), true);
        });

        reuseCase.check(() => {
            const clientRequestId = reuseCase.client().transaction().request.id();
            const matchingTransaction = cachePeer.startedTransactions().find(x => x.request && x.request.id() === clientRequestId);
            assert.strictEqual(matchingTransaction.reusedTransportConnection(), expectReuseWithCachePeer);

            reuseCase.accessRecords().single().checkEqualIn('%transport::>connection_id', openCase.accessRecords().single());
        });

        return reuseCase;
    }
}
