// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Check whether the proxy reuses a persistent connection with the server.

import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import * as AddressPool from "../src/misc/AddressPool";
import Test from "../src/overlord/Test";

export default class MyTest extends Test {

    async run(/*testRun*/) {
        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.finalize();

        // TODO: Support client-proxy pconns as well.

        const openCase = new HttpTestCase('create a proxy-server pconn');
        openCase.client().request.for(resource);
        openCase.server().serve(resource);
        // TODO: This should be a standard, HTTP version-sensitive method
        openCase.server().response.header.add("Connection", "keep-alive");
        assert(openCase.server().response.persistent());
        openCase.server().keepConnections();
        openCase.addMissCheck();
        await openCase.run();

        const reuseCase = new HttpTestCase('reuse a proxy-server pconn');
        reuseCase.client().request.for(resource);
        reuseCase.server().serve(resource);
        reuseCase.server().reuseConnectionsFrom(openCase.server());
        reuseCase.addMissCheck();
        await reuseCase.run();
    }
}
