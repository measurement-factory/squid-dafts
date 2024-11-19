// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Check that proxy properly handles URN requests

import * as Config from "../src/misc/Config";
import * as Misc from "../src/misc/Gadgets";
import * as Http from "../src/http/Gadgets";
import * as AddressPool from "../src/misc/AddressPool";
import Body from "../src/http/Body";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import assert from "assert";
import Test from "../src/overlord/Test";
import ConfigGen from "../src/test/ConfigGen";

const MaximumSupportedResponseLength = 4096 - 1;
const UrnResponseUrl = 'http://example.com';

export default class MyTest extends Test {
    static Configurators() {
        const configGen = new ConfigGen();
        configGen.addGlobalConfigVariation({responseEndsAtEof: [
            false,
            true,
        ]});
        return configGen.generateConfigurators();
    }

    _configureDut(cfg) {
        cfg.memoryCaching(true);
        cfg.diskCaching(false);
        // Squid always directs URN responses to port 80.
        // With this cache_peer configuration, we force Squid to send requests to our server.
        // Since the server is not up yet when proxy starts, the proxy marks it as a 'dead' peer
        // (and the subsequent request fails). To overcome this problem, we need prepareProxy() call
        // first to force Squid to 'revive' this dead peer.
        cfg.custom(`cache_peer ${Config.OriginAuthority.host} parent ${Config.OriginAuthority.port} 0 no-netdb-exchange originserver name=Peer1`); 
        cfg.custom('cache_peer_access Peer1 allow all');
        cfg.custom('never_direct allow all');
    }

    async testUrn(size) {
        assert(size <= MaximumSupportedResponseLength);

        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        if (size > 0) {
            let body = UrnResponseUrl;
            if (size > UrnResponseUrl.length)
                body += '/' + 'x'.repeat(size - UrnResponseUrl.length - 1);
            resource.body = new Body(body);
        } else {
            resource.body = new Body("");
        }
        resource.finalize();

        let urnResource = new Resource();
        urnResource.uri.address = resource.uri.address;
        urnResource.uri.makeUrn();
        urnResource.uri.address = Config.OriginAuthority;
        urnResource.finalize();

        const testCase = new HttpTestCase(`URN scheme`);
        testCase.client().request.for(urnResource);
        testCase.server().serve(resource);

        testCase.check(() => {
            testCase.expectStatusCode(302);
            const response = testCase.client().transaction().response;
            const body = response.body.whole();
            if (size > 0) {
                assert(body.includes(UrnResponseUrl));
                assert(response.header.has('Location'));
                assert(response.header.value('Location').startsWith(UrnResponseUrl));
            }
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async prepareProxy() {
        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.finalize();

        // force Squid to revive dead peer (i.e., our server)
        {
            let missCase = new HttpTestCase(`cache a response`);
            missCase.server().serve(resource);
            missCase.client().request.for(resource);
            await missCase.run();
        }

        // get a response to check that Squid has revived the dead peer
        {
            let missCase = new HttpTestCase(`cache a response`);
            missCase.server().serve(resource);
            missCase.client().request.for(resource);
            missCase.addMissCheck();
            await missCase.run();
        }

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run() {
        await this.prepareProxy();
        const bodies = [0, UrnResponseUrl.length, MaximumSupportedResponseLength];
        for (let size of bodies) {
            await this.testUrn(size);
        }
    }
}

