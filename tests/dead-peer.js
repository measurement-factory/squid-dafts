// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Checks handling of transactions that fail due to non-listening peers.

import assert from "assert";

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as CachePeer from "../src/overlord/CachePeer";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
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

    async testGetDirectlyToBadOrigin() {
        const originAddress = AddressPool.ReserveListeningAddress();

        let testCase = new HttpTestCase('GET directly to a non-listening origin');
        testCase.client().request.startLine.uri.address = originAddress;
        // no server to simulate an origin that is not listening

        testCase.check(async () => {
            testCase.expectStatusCode(503);
            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'WITH_SERVER+errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_MISS_ABORTED');
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', 'GET');
            accessRecord.checkEqual('%Sh', 'HIER_DIRECT');
            accessRecord.checkKnown('%<a');
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(originAddress);
    }

    async testConnectDirectlyToBadOrigin() {
        const originAddress = AddressPool.ReserveListeningAddress();

        let testCase = new HttpTestCase('CONNECT directly to a non-listening origin');
        testCase.client().request.startLine.uri.address = {
            host: Config.originAuthority().host,
            port: 443
        };
        testCase.client().request.startLine.method = 'CONNECT';
        // no server to simulate an origin that is not listening

        testCase.check(async () => {
            testCase.expectStatusCode(503);
            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'WITH_SERVER+errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_MISS_ABORTED');
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', 'GET');
            accessRecord.checkEqual('%Sh', 'HIER_DIRECT');
            accessRecord.checkKnown('%<a');
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(originAddress);
    }

    async testGetThroughCachePeerToBadOrigin() {
        const originAddress = AddressPool.ReserveListeningAddress();

        let testCase = new HttpTestCase('GET through a cache_peer to a non-listening origin');
        testCase.client().request.startLine.uri.address = originAddress;
        // no server to simulate an origin that is not listening

        this._configureCachePeersTalkingToBadOrigin();

        CachePeer.Attract(testCase.client().request);

        testCase.check(async () => {
            testCase.expectStatusCode(503);
            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkUnknown('%err_code');
            accessRecord.checkUnknown('%err_detail');
            accessRecord.checkEqual('%Ss', 'TCP_MISS');
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', 'GET');
            accessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
            accessRecord.checkKnown('%<a');
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(originAddress);
    }

    async testConnectThroughCachePeerToBadOrigin() {
        let testCase = new HttpTestCase('CONNECT through a cache_peer to a non-listening origin');
        this._configureCachePeersTalkingToBadOrigin();

        testCase.client().request.startLine.uri.address = {
            host: Config.originAuthority().host,
            port: 443
        };
        testCase.client().request.startLine.method = 'CONNECT';
        CachePeer.Attract(testCase.client().request);

        testCase.check(async () => {
            testCase.expectStatusCode(503);
            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkEqual('%err_code', 'ERR_RELAY_REMOTE');
            accessRecord.checkUnknown('%err_detail');
            accessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', 'CONNECT');
            accessRecord.checkEqual('%Sh', 'FIRSTUP_PARENT');
            accessRecord.checkKnown('%<a');
        });

        await testCase.run();
    }

    async testGetThroughBadCachePeer() {
        const originAddress = AddressPool.ReserveListeningAddress();

        const resource = new Resource();
        resource.uri.address = originAddress;
        resource.finalize();

        let testCase = new HttpTestCase('GET through a non-listening cache_peer');

        testCase.client().request.for(resource);
        CachePeer.Attract(testCase.client().request);
        testCase.server().serve(resource);

        testCase.check(async () => {
            testCase.expectStatusCode(503);
            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'WITH_SERVER+errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_MISS_ABORTED');
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', 'GET');
            accessRecord.checkEqual('%Sh', this._expectedBadPeerHierarchyStatus());
            accessRecord.checkKnown('%<a');
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(originAddress);
    }

    async testConnectThroughBadCachePeer() {
        let testCase = new HttpTestCase('CONNECT through a non-listening cache_peer');

        testCase.client().request.startLine.uri.address = {
            host: Config.originAuthority().host,
            port: 443
        };
        testCase.client().request.startLine.method = 'CONNECT';
        CachePeer.Attract(testCase.client().request);

        testCase.check(async () => {
            testCase.expectStatusCode(503);
            const accessRecords = await this.dut.getNewAccessRecords();
            const accessRecord = accessRecords.single();
            accessRecord.checkEqual('%err_code', 'ERR_CONNECT_FAIL');
            accessRecord.checkEqual('%err_detail', 'errno=111');
            accessRecord.checkEqual('%Ss', 'TCP_TUNNEL');
            accessRecord.checkEqual('%>Hs', '503');
            accessRecord.checkEqual('%rm', 'CONNECT');
            accessRecord.checkEqual('%Sh', this._expectedBadPeerHierarchyStatus());
            accessRecord.checkKnown('%<a');
        });

        await testCase.run();
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

    // expected %Sh value for cases testing non-listening cache_peers
    _expectedBadPeerHierarchyStatus() {
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
