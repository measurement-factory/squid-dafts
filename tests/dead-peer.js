// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Checks handling of transactions that fail due to non-listening peers.

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

        testCase.check(() => {
            testCase.expectStatusCode(503);
            // TODO: Check access.log fields
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

        testCase.check(() => {
            testCase.expectStatusCode(503);
            // TODO: Check access.log fields
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

        testCase.check(() => {
            testCase.expectStatusCode(503);
            // TODO: Check access.log fields
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

        testCase.check(() => {
            testCase.expectStatusCode(503);
            // TODO: Check access.log fields
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

        testCase.check(() => {
            testCase.expectStatusCode(503);
            // TODO: Check access.log fields
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

    async run(/*testRun*/) {
        // TODO: Add generic Config support for selecting which cases to run
        // based on their MyTest::testX() method name suffixes.

        if (!Config.dutCachePeers()) {
            await this.testGetDirectlyToBadOrigin();
            return; // the other test cases require at least one cache_peer
        }

        await this.testGetThroughCachePeerToBadOrigin();
        await this.testConnectThroughCachePeerToBadOrigin();

        // the remaining test cases need cache_peers that do not listen
        await this.dut.stopCachePeers();

        // cache_peers that do not listen may generate ERRORs
        this.dut.ignoreProblems(/Connection to peer.*failed/);

        await this.testGetThroughBadCachePeer();
        await this.testConnectThroughBadCachePeer();
    }
}
