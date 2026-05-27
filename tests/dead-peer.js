// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Checks handling of transactions that fail due to non-listening peers,
// including origin servers and cache_peers.

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
            yield 0;
            yield 1;
            yield 2;
        });

        return configGen.generateConfigurators();
    }

    async testGetDirectlyToBadOrigin() {
        const testCase = this._makeTestCase('GET', 'directly to a non-listening origin');

        testCase.check(() => {
            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'WITH_SERVER+errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_MISS_ABORTED');
            accessRecord.checkEqual('%Sh', 'HIER_DIRECT');
        });

        await testCase.run();
    }

    async testConnectDirectlyToBadOrigin() {
        const testCase = this._makeTestCase('CONNECT', 'directly to a non-listening origin');

        testCase.check(() => {
            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            accessRecord.checkEqual('%Sh', 'HIER_DIRECT');
        });

        await testCase.run();
    }

    async testGetThroughCachePeerToBadOrigin() {
        const testCase = this._makeTestCase('GET', `through ${this._goodCachePeerDescription()} to a non-listening origin`);

        this._configureCachePeersTalkingToBadOrigin();

        testCase.check(() => {
            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkUnknown('%err_code');
            accessRecord.checkUnknown('%err_detail');
            accessRecord.checkEqual('%Ss', 'TCP_MISS');
            accessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
        });

        await testCase.run();
    }

    async testConnectThroughCachePeerToBadOrigin() {
        const testCase = this._makeTestCase('CONNECT', `through ${this._goodCachePeerDescription()} to a non-listening origin`);

        this._configureCachePeersTalkingToBadOrigin();

        testCase.check(() => {
            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkEqual('%err_code', 'ERR_RELAY_REMOTE');
            accessRecord.checkUnknown('%err_detail');
            accessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            accessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
        });

        await testCase.run();
    }

    async testGetThroughBadCachePeer() {
        const testCase = this._makeTestCase('GET', `through ${this._badCachePeerDescription()}`);

        testCase.check(() => {
            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'WITH_SERVER+errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_MISS_ABORTED');
            accessRecord.checkEqual('%Sh', this._expectedBadCachePeerHierarchyStatus());
        });

        await testCase.run();
    }

    async testConnectThroughBadCachePeer() {
        const testCase = this._makeTestCase('CONNECT', `through ${this._badCachePeerDescription()}`);

        testCase.check(() => {
            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            accessRecord.checkEqual('%Sh', this._expectedBadCachePeerHierarchyStatus());
        });

        await testCase.run();
    }

    // HttpTestCase configuration shared among all test cases
    _makeTestCase(requestMethod, pathDescription) {
        const testCase = new HttpTestCase(`${requestMethod} ${pathDescription}`);

        testCase.client().request.startLine.method = requestMethod;
        testCase.client().request.startLine.uri.address = {
            host: Config.originAuthority().host,
            // use default (privileged) ports because we use no origin server
            port: (requestMethod === "CONNECT" ? 443 : 80),
        };

        if (Config.dutCachePeers() > 0)
            CachePeer.Attract(testCase.client().request);

        // no server, either to simulate an origin that is not listening or
        // because no server is used when all cache_peers are not listening

        testCase.expectAccessRecordChecks(this.dut);

        testCase.check(() => {
            testCase.expectStatusCode(503);

            const accessRecord = testCase.accessRecords().single();
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', requestMethod);
            accessRecord.checkKnown('%<a');
        });

        return testCase;
    }

    // simulate what a cache_peer does when the origin is not listening
    async _configureCachePeersTalkingToBadOrigin() {
        this.dut.cachePeers().forEach(cachePeer => {
            cachePeer.resetTransaction();
            cachePeer.response.startLine.code(503);
        });
    }

    _goodCachePeerDescription() {
        const peers = Config.dutCachePeers();
        assert(peers);
        return peers > 1 ? `the first of ${peers} cache_peers` : 'a cache_peer';
    }

    _badCachePeerDescription() {
        const peers = Config.dutCachePeers();
        assert(peers);
        return peers > 1 ? `${peers} non-listening cache_peers` : 'a non-listening cache_peer';
    }

    // expected %Sh value for cases testing non-listening cache_peers
    _expectedBadCachePeerHierarchyStatus() {
        const peers = Config.dutCachePeers();
        assert(peers);
        return peers > 1 ? 'ANY_OLD_PARENT' : 'FIRSTUP_PARENT';
    }

    async run(/*testRun*/) {
        // TODO: Add generic Config support for selecting which cases to run
        // based on their MyTest::testX() method name suffixes.

        if (!Config.dutCachePeers()) {
            await this.testGetDirectlyToBadOrigin();
            await this.testConnectDirectlyToBadOrigin();
            return; // the other test cases require at least one cache_peer
        }

        // cache_peers that return 503s may generate ERRORs;
        // cache_peers that do not listen may generate ERRORs
        this.dut.ignoreProblems(/Connection to peer.* failed/); // Squids that do not detail outgoing connection failures
        this.dut.ignoreProblems(/Cannot establish CONNECT tunnel/); // Squids that do (cache_peer cases)
        this.dut.ignoreProblems(/Failed to establish a TCP connection/); // Squids that do (DIRECT cases)

        await this.testGetThroughCachePeerToBadOrigin();
        await this.testConnectThroughCachePeerToBadOrigin();

        // the remaining test cases need cache_peers that do not listen
        await this.dut.stopCachePeers();

        await this.testGetThroughBadCachePeer();
        await this.testConnectThroughBadCachePeer();
    }
}
