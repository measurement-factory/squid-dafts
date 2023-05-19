// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Checks handling of transactions that fail due to non-listening peers.

import assert from "assert";

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as CachePeer from "../src/overlord/CachePeer";
import HttpTestCase from "../src/test/HttpCase";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

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

    constructor() {
        super(...arguments);

        this._lastAccessRecord = null; // cached by check() in _makeTestCase()
    }

    async testGetDirectlyToBadOrigin() {
        const testCase = this._makeTestCase('GET', 'directly to a non-listening origin');

        testCase.check(() => {
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            this._lastAccessRecord.checkEqual('%err_detail', 'WITH_SERVER+errno=111');
            this._lastAccessRecord.checkEqual('%Ss', 'TCP_MISS_ABORTED');
            this._lastAccessRecord.checkEqual('%Sh', 'HIER_DIRECT');
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(testCase.client().request.startLine.uri.address);
    }

    async testConnectDirectlyToBadOrigin() {
        const testCase = this._makeTestCase('CONNECT', 'directly to a non-listening origin');

        testCase.check(() => {
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            this._lastAccessRecord.checkEqual('%err_detail', 'errno=111');
            this._lastAccessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            this._lastAccessRecord.checkEqual('%Sh', 'HIER_DIRECT');
        });

        await testCase.run();
    }

    async testGetThroughCachePeerToBadOrigin() {
        const testCase = this._makeTestCase('GET', `through ${this._goodCachePeerDescription()} to a non-listening origin`);

        this._configureCachePeersTalkingToBadOrigin();

        testCase.check(() => {
            this._lastAccessRecord.checkUnknown('%err_code');
            this._lastAccessRecord.checkUnknown('%err_detail');
            this._lastAccessRecord.checkEqual('%Ss', 'TCP_MISS');
            this._lastAccessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(testCase.client().request.startLine.uri.address);
    }

    async testConnectThroughCachePeerToBadOrigin() {
        const testCase = this._makeTestCase('CONNECT', `through ${this._goodCachePeerDescription()} to a non-listening origin`);

        this._configureCachePeersTalkingToBadOrigin();

        testCase.check(() => {
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_RELAY_REMOTE');
            this._lastAccessRecord.checkUnknown('%err_detail');
            this._lastAccessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            this._lastAccessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
        });

        await testCase.run();
    }

    async testGetThroughBadCachePeer() {
        const testCase = this._makeTestCase('GET', `through ${this._badCachePeerDescription()}`);

        testCase.check(() => {
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            this._lastAccessRecord.checkEqual('%err_detail', 'WITH_SERVER+errno=111');
            this._lastAccessRecord.checkEqual('%Ss', 'TCP_MISS_ABORTED');
            this._lastAccessRecord.checkEqual('%Sh', this._expectedBadCachePeerHierarchyStatus());
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(testCase.client().request.startLine.uri.address);
    }

    async testConnectThroughBadCachePeer() {
        const testCase = this._makeTestCase('CONNECT', `through ${this._badCachePeerDescription()}`);

        testCase.check(() => {
            this._lastAccessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            this._lastAccessRecord.checkEqual('%err_detail', 'errno=111');
            this._lastAccessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            this._lastAccessRecord.checkEqual('%Sh', this._expectedBadCachePeerHierarchyStatus());
        });

        await testCase.run();
    }

    // HttpTestCase configuration shared among all test cases
    _makeTestCase(requestMethod, pathDescription) {
        const testCase = new HttpTestCase(`${requestMethod} ${pathDescription}`);

        testCase.client().request.startLine.method = requestMethod;

        if (requestMethod === "CONNECT") {
            testCase.client().request.startLine.uri.address = {
                host: Config.originAuthority().host,
                port: 443
            };
        } else {
            testCase.client().request.startLine.uri.address = AddressPool.ReserveListeningAddress();
        }

        if (Config.dutCachePeers() > 0)
            CachePeer.Attract(testCase.client().request);

        // no server, either to simulate an origin that is not listening or
        // because no server is used when all cache_peers are not listening

        testCase.check(async () => {
            testCase.expectStatusCode(503);

            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', requestMethod);
            accessRecord.checkKnown('%<a');
            this._lastAccessRecord = accessRecord;
        });

        return testCase;
    }

    // simulate what a cache_peer does when the origin is not listening
    async _configureCachePeersTalkingToBadOrigin() {
        this.dut.cachePeers().forEach(cachePeer => {
            cachePeer.resetTransaction();
            cachePeer.response.startLine.code(503);
            cachePeer.response.header.add("Via",
                `1.1 ${cachePeer.context.id} (Daft-cache_peer)`);
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
        this.dut.ignoreProblems(/Connection to peer.* failed/);

        await this.testGetThroughCachePeerToBadOrigin();
        await this.testConnectThroughCachePeerToBadOrigin();

        // the remaining test cases need cache_peers that do not listen
        await this.dut.stopCachePeers();


        await this.testGetThroughBadCachePeer();
        await this.testConnectThroughBadCachePeer();
    }
}
