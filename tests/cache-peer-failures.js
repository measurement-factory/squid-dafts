// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Checks handling of a failed transaction involving a cache_peer.
// TODO: Refactoring into more general forwarding-failures?

import * as AddressPool from "../src/misc/AddressPool";
import * as Config from "../src/misc/Config";
import * as CachePeer from "../src/overlord/CachePeer";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import Test from "../src/overlord/Test";
import { FlexibleConfigGen } from "../src/test/ConfigGen";

Config.Recognize([
    {
        option: "cache-peers",
        type: "Number",
        description: "the number of proxy cache_peers to use",
    },
]);

export default class MyTest extends Test {

    static Configurators() {
        const configGen = new FlexibleConfigGen();

        configGen.cachePeers(function *() {
            yield 1;
            yield 2;
        });

        return configGen.generateConfigurators();
    }

    constructor() {
        super(...arguments);
    }

    _configureDut(cfg) {
        cfg.withCachePeers(Config.cachePeers());
    }

    async testConnectThroughCachePeerToBadOrigin() {
        let testCase = new HttpTestCase('CONNECT to a non-listening origin through a cache_peer');

        // simulate what a cache_peer does when the origin is not listening
        this.dut.cachePeers().forEach(cachePeer => {
            cachePeer.resetTransaction();
            cachePeer.response.startLine.code(503);
            cachePeer.response.header.add("Via",
                `1.1 ${cachePeer.context.id} (Daft-cache_peer)`);
        });

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
        let testCase = new HttpTestCase('CONNECT to a non-listening cache_peer');

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

    async run(/*testRun*/) {
        await this.testConnectThroughCachePeerToBadOrigin();

        // the remaining test cases need cache_peers that do not listen
        await this.dut.stopCachePeers();

        await this.testGetThroughBadCachePeer();
        await this.testConnectThroughBadCachePeer();
    }
}
