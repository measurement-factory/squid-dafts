// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Check whether the proxy reuses persistent connections with the client and server.

import * as AddressPool from "../src/misc/AddressPool.js";
import assert from "assert";
import HttpTestCase from "../src/test/HttpCase.js";
import Resource from "../src/anyp/Resource.js";
import Test from "../src/overlord/Test.js";

export default class MyTest extends Test {

    async run(/*testRun*/) {
        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.finalize();

        const openCase = new HttpTestCase('create pconns');
        openCase.client().request.for(resource);
        openCase.server().serve(resource);
        openCase.client().keepConnections();
        openCase.server().keepConnections();
        openCase.expectAccessRecordChecks(this.dut);
        openCase.addMissCheck();
        openCase.client().checks.add((client) => {
            assert(client.transaction().request.persistent()); // code check
            assert(client.transaction().response.persistent());
        });
        openCase.server().checks.add((server) => {
            assert(server.transaction().request.persistent());
            assert(server.transaction().response.persistent()); // code check
        });
        openCase.check(() => {
            openCase.accessRecords().single().checkKnown('%transport::>connection_id');
        });
        await openCase.run();

        const reuseCase = new HttpTestCase('reuse pconns');
        reuseCase.client().request.for(resource);
        reuseCase.server().serve(resource);
        reuseCase.client().reuseConnectionsFrom(openCase.client());
        reuseCase.server().reuseConnectionsFrom(openCase.server());
        reuseCase.expectAccessRecordChecks(this.dut);
        reuseCase.addMissCheck();
        reuseCase.client().checks.add((client) => {
            // Without keepConnections(), the client should signal connection
            // closure, and the proxy has to respond in kind.
            assert(!client.transaction().request.persistent()); // code check
            assert(!client.transaction().response.persistent());
            assert.strictEqual(client.transaction().reusedTransportConnection(), true);
        });
        reuseCase.server().checks.add((server) => {
            // The proxy may signal connection reuse, but the server must
            // signal connection closure since there was no keepConnections().
            assert(!server.transaction().response.persistent()); // code check
            assert.strictEqual(server.transaction().reusedTransportConnection(), true);
        });
        reuseCase.check(() => {
            // TODO: Check %transport::<connection_id when Squid supports that.
            reuseCase.accessRecords().single().checkEqualIn('%transport::>connection_id', openCase.accessRecords().single());
        });
        await reuseCase.run();
    }
}
