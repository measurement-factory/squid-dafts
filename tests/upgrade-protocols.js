// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

/*
 * Tests Squid implementation of the HTTP Upgrade mechanism (RFC 7230).
 *
 * Each test case configures Squid to allow zero or more Upgrade protocols,
 * sends an Upgrade request with zero or more protocol offers, and sends an
 * 101 response with (or without) an Upgrade response header. The test case
 * checks that Squid filtered the offered protocols as configured and properly
 * allowed (or blocked) the upgrade.
 */

import * as Config from "../src/misc/Config";
import * as Http from "../src/http/Gadgets";
import * as AddressPool from "../src/misc/AddressPool";
import HttpTestCase from "../src/test/HttpCase";
import Resource from "../src/anyp/Resource";
import HeaderField from "../src/http/Field";
import Body from "../src/http/Body";
import assert from "assert";
import Test from "../src/overlord/Test";
import { DutConfig } from "../src/overlord/Proxy";

Config.Recognize([
    {
        option: "client-upgrades",
        type: "String",
        default: "ALL",
        description: `Upgrade protocol(s) to be offered by the client. Specify
                      either a single Upgrade request header field value or a
                      name of a well-known protocol list (EMPTY, MAX, or ALL).`
    },
    {
        option: "server-upgrades",
        type: "String",
        default: "ALL",
        description: `Upgrade protocol(s) the server will switch to. Specify
                      either a single Upgrade response header field value or a
                      name of a well-known protocol list (NONE, EMPTY, MAX, or
                      ALL).`
    },
    {
        option: "other-rules",
        type: "String",
        default: "none",
        description: `'allow': allow all other protocols;
                      'deny': explicitly deny all other protocols;
                      'none': implicitly deny all other protocols.`
    },
    {
        option: "protocols-per-field",
        type: "String",
        default: "ALL",
        description: `'1': one protocol spec per HTTP Upgrade field;
                      'all': all protocol specs in a single field;
                      'ALL': test all supported variations.`
    }
]);

// Represents a single Upgrade header field value, such as 'WebSocket/1'.
// We use shallow copies of Protocol arrays -- Protocol objects must not change!
class Protocol
{
    constructor(nameOrBoth, versionOrNull = null) {
        if (arguments.length === 2) {
            this.name = nameOrBoth;
            this.version = versionOrNull;
            return;
        }

        const idx = nameOrBoth.indexOf('/');
        if (idx !== -1) {
            this.name = nameOrBoth.substring(0, idx);
            this.version = nameOrBoth.substring(idx + 1);
        } else {
            this.name = nameOrBoth;
            this.version = null;
        }
    }

    versioned() {
        return this.version !== null;
    }

    gist() {
        if (this.versioned())
            return this.name + '/' + this.version;
        return this.name;
    }

    // matches an explicit "allow" rule in the current Squid configuration
    allowed() {
        if (this._explicitlyAllowed())
            return true;

        return !this._explicitlyDenied() &&
            Config.OtherRules === 'allow';
    }

    // matches an explicit "P allow" or "P/V allow" rule
    _explicitlyAllowed() {
        // when the name conflicts with the version, our rules go by the version
        if (this.version) {
            if (this.version.includes('good'))
                return true;
            if (this.version.includes('bAd'))
                return true;

            if (this.version.includes('bad'))
                return false;
            if (this.version.includes('gOOd'))
                return false;
        }
        return this.name.includes('good') || this.name.includes('bAd');
    }

    // matches an explicit "P deny" or "P/V deny" rule
    _explicitlyDenied() {
        // when the name conflicts with the version, our rules go by the version
        if (this.version) {
            if (this.version.includes('bad'))
                return true;
            if (this.version.includes('gOOd'))
                return true;

            if (this.version.includes('good'))
                return false;
            if (this.version.includes('bAd'))
                return false;
        }
        return this.name.includes('bad') || this.name.includes('gOOd');
    }
}

// configuration of a single Upgrade transaction
class TransactionConfig
{
    constructor(clientProtocols, serverProtocols) {
        assert.strictEqual(arguments.length, 2);
        assert.notEqual(clientProtocols, null);
        this._clientProtocols = clientProtocols;
        this._serverProtocols = serverProtocols;
        this.oneProtocolPerField = false;
    }

    // provides API symmetry with serverProtocols()
    clientProtocols() {
        return this._clientProtocols;
    }

    serverProtocols() {
        return this._serverProtocols === null ? [] : this._serverProtocols;
    }

    allowedProtocols() {
        return this._clientProtocols.filter(v => v.allowed());
    }

    clientHeaders() {
        return this._toFields(this._clientProtocols);
    }

    serverHeaders() {
        if (!this._serverProtocols)
            return null;
        return this._toFields(this._serverProtocols);
    }

    upgradePossible() {
        if (!this._clientProtocols.length) {
            console.log('Upgrade impossible because the client did not offer to upgrade');
            return false;
        }

        if (!this.allowedProtocols().length) {
            console.log('Upgrade impossible because Squid blocked all client Upgrade protocols');
            return false;
        }

        if (this._serverProtocols === null) {
            console.log('Upgrade impossible because the server sent no Upgrade');
            return false;
        }

        if (!this._serverProtocols.length) {
            console.log('Upgrade impossible because the server sent an empty Upgrade');
            return false;
        }

        // Squid does not restrict server responses further
        return true;
    }

    _toFields(protocols) {
        //protocols.map(v => console.log("v[i]: ", v));
        if (this.oneProtocolPerField)
            return protocols.map(p => new HeaderField("Upgrade", p.gist()));

        const value = protocols.map(p => p.gist()).join(',');
        return [new HeaderField("Upgrade", value)];
    }

}

// DutConfig with custom http_upgrade_request_protocols rules
class MyDutConfig extends DutConfig {
    constructor(...args) {
        super(...args);

        const rulesForGood = [
            'http_upgrade_request_protocols good allow all',
            'http_upgrade_request_protocols good1/goodv allow all',
            'http_upgrade_request_protocols good1/badv deny all',
            'http_upgrade_request_protocols good1 allow all',
            'http_upgrade_request_protocols 2good2/vbadv deny all',
            'http_upgrade_request_protocols 2good2 allow all',
            // to check that the proxy treats "bAd" differently from "bad"
            'http_upgrade_request_protocols bAd allow all',
            'http_upgrade_request_protocols bad3/bAd allow all'
        ];
        const rulesForBad = [
            'http_upgrade_request_protocols bad deny all',
            'http_upgrade_request_protocols 1bad/goodv allow all',
            'http_upgrade_request_protocols 2bad2/vgood allow all',
            'http_upgrade_request_protocols 2bad2 deny all',
            // to check that the proxy treats "gOOd" differently from "good"
            'http_upgrade_request_protocols gOOd deny all',
            'http_upgrade_request_protocols good3/gOOd deny all'
        ];
        if (Config.OtherRules === 'none') {
            this._addRules(rulesForGood, rulesForBad, null);
            // implicit: http_upgrade_request_protocols OTHER deny all
        } else if (Config.OtherRules === 'allow') {
            this._addRules(rulesForGood, rulesForBad,
                'http_upgrade_request_protocols OTHER allow all');
        } else {
            assert.strictEqual(Config.OtherRules, 'deny');
            this._addRules(rulesForBad, rulesForGood,
                'http_upgrade_request_protocols OTHER deny all');
        }
    }

    _addRules(group1, group2, other) {
        assert.strictEqual(arguments.length, 3);

        // we want to consume these arrays
        let g1 = group1.slice(0);
        let g2 = group2.slice(0);

        const skipVersionlessClustersInG1 = (other !== null);

        let ruleCount = 0;
        const middleCount = (group1.length + group2.length) / 2;
        while (g1.length || g2.length || other) {
            let rule = null;

            // tempt the proxy with checking the OTHER rule too early
            if (!rule && other && ruleCount >= middleCount) {
                rule = other;
                other = null;
            }

            // we cannot (easily) shuffle in-group rules, but we can interleave
            // group1/group2 rules in hope to confuse the proxy
            const preferG2 = (ruleCount % 2) && g2.length;
            while (!rule && g1.length && !preferG2) {
                rule = g1.shift();
                if (skipVersionlessClustersInG1 && (
                    rule.includes(' good ') ||
                    rule.includes(' gOOd ') ||
                    rule.includes(' bad ') ||
                    rule.includes(' bAd ')))
                    rule = null;
            }

            if (!rule && g2.length) {
                rule = g2.shift();
            }

            assert.notEqual(rule, null);
            this.custom(rule);
            ++ruleCount;
        }
    }
}


// computes all TransactionConfigs for a single Test
class TestConfig {
    // creates a mesh of client x server configurations
    generate() {
        let caseConfigs = [];
        for (let clientConfig of this._clientConfigs()) {
            for (let serverConfig of this._serverConfigs()) {
                caseConfigs.push(new TransactionConfig(clientConfig, serverConfig));
            }
        }
        return caseConfigs;
    }

    // client-offered protocols hand-picked to better exercise Upgrade code
    static _ClientProtocols() {
        return [
            "/",
            "/v",

            "bad",
            "bad/",
            "1bad",
            "1bad/badv",
            "1bad/goodv",
            "2bad2",
            "2bad2/vbad",
            "2bad2/vgood",

            "good",
            "good/",
            "good1",
            "good1/goodv",
            "good1/badv",
            "2good2",
            "2good2/vgoodv",
            "2good2/vbadv",

            "other",
            "other/1",
        ].map(gist => new Protocol(gist));
    }

    // server-selected protocols; enough to exercise Squid's rudimentary checks
    static _ServerProtocols() {
        return [
            "whatever",
        ].map(gist => new Protocol(gist));
    }

    _clientConfigs() {
        const knownProtos = TestConfig._ClientProtocols();
        return this._agentConfigs(knownProtos, Config.ClientUpgrades);
    }

    _serverConfigs() {
        if (Config.ServerUpgrades === 'NONE')
            return [ null ]; // single case, no Upgrade header

        const knownProtos = TestConfig._ServerProtocols();
        const configs = this._agentConfigs(knownProtos, Config.ServerUpgrades);

        if (Config.ServerUpgrades === 'ALL')
            return [ null, ...configs ]; // add NONE case to ALL configurations

        return configs;
    }

    _agentConfigs(knownProtos, requestedCfg) {
        // Single case: An empty Upgrade header.
        if (requestedCfg === 'EMPTY')
            return [ [] ];

        // Single case: an Upgrade header listing all protocols.
        if (requestedCfg === 'MAX')
            return [ [...knownProtos] ];

        if (requestedCfg === 'ALL')
            return this._allAgentConfigs(knownProtos);

        if (requestedCfg.toUpperCase() === requestedCfg &&
            requestedCfg.toLowerCase() !== requestedCfg)
            throw new Error("unsupported --client-upgrades or --server-upgrades value: " + requestedCfg);

        // Single case: An Upgrade header listing the specified protocols.
        // no support for empty protocols as in "foo,,bar", ",foo", or "bar,"
        return [ TestConfig.ParseUpgradeValue(requestedCfg) ];
    }

    // parse a comma-separated value list
    static ParseUpgradeValue(value) {
        return value.trim().split(/(?:\s*,\s*)+/).filter(v => v.length).map(gist => new Protocol(gist));
    }

    // parse an array of comma-separated value lists
    static ParseUpgradeValues(values) {
        let protos = [];
        for (let value of values) {
            const fieldProtos = TestConfig.ParseUpgradeValue(value);
            protos = protos.concat(fieldProtos);
        }
        return protos;
    }

    // ALL: configurations of all side-agnostic cases
    _allAgentConfigs(knownProtos) {
        let configs = [];
        configs.push(...this._agentConfigs(knownProtos, 'EMPTY'));
        configs.push(...this._agentConfigs(knownProtos, 'MAX'));
        for (let p of knownProtos)
            configs.push([p]); // add a case with an Upgrade:p header
        return configs;
    }
}

export default class MyTest extends Test {
    _createDutConfig() {
        return new MyDutConfig();
    }

    _configureDut(cfg) {
        cfg.memoryCaching(true);
    }

    async _runOne(cfg) {
        let resource = new Resource();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body("x".repeat(16));
        resource.finalize();

        let testCase = new HttpTestCase('Upgrade transaction');
        testCase.client().request.for(resource);
        testCase.client().request.header.addMany(...cfg.clientHeaders());

        // fake 0-RTT client payload
        const earlyClientBody = new Body("c".repeat(Config.DefaultBodySize()));
        testCase.client().request.addBody(earlyClientBody);
        testCase.client().request.header.add(Http.DaftFieldName("Content-Length"), earlyClientBody.innedSize());
        testCase.client().request.header.prohibitNamed("Content-Length");
        testCase.client().request.header.prohibitNamed("Transfer-Encoding");

        testCase.server().response.startLine.code(101);
        if (cfg.serverHeaders())
            testCase.server().response.header.addMany(...cfg.serverHeaders());
        testCase.server().response.header.add("Connection", "Upgrade");
        testCase.server().response.forceEof = true;
        testCase.server().serve(resource);

        testCase.check(() => {
                const serverReceived = testCase.server().transaction().request.header.values("Upgrade");
                const serverReceivedProtos = TestConfig.ParseUpgradeValues(serverReceived);
                const clientReceived = testCase.client().transaction().response.header.values("Upgrade");
                const clientReceivedProtos = TestConfig.ParseUpgradeValues(clientReceived);
                const serverExpectedProtos = cfg.allowedProtocols();

                // Squid properly forwarded all allowed offers to the server
                MyTest.CheckForwardedAsIs(serverExpectedProtos, serverReceivedProtos);

                if (cfg.upgradePossible()) {
                    testCase.expectStatusCode(101);
                    // Squid properly forwarded all server-accepted protocols
                    MyTest.CheckForwardedAsIs(cfg.serverProtocols(), clientReceivedProtos);

                    // TODO: Check such basic forwarding by default.

                    // Check that client-to-server headers and 0-RTT
                    // upgraded-protocol bytes were forwarded.
                    Http.AssertForwardedMessage(
                        testCase.client().transaction().request,
                        testCase.server().transaction().request,
                        "request");

                    // Check that server-to-client headers and early
                    // upgraded-protocol bytes were forwarded.
                    Http.AssertForwardedMessage(
                        testCase.server().transaction().response,
                        testCase.client().transaction().response,
                        "response");

                    // TODO: Check that tunneling works beyond early bytes.
                } else {
                    testCase.expectStatusCode(502);
                    // Squid does not know what Upgrade values would have worked
                    assert.strictEqual(clientReceivedProtos.length, 0);
                }
        });

        await testCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    // whether all sentProtocols were forwarded, in the sent order
    static CheckForwardedAsIs(sentProtocols, receivedProtocols) {
        assert.strictEqual(receivedProtocols.length, sentProtocols.length);
        for (let idx = 0; idx < sentProtocols.length; ++idx) {
            assert.strictEqual(receivedProtocols[idx].gist(), sentProtocols[idx].gist());
        }
    }

    async run() {
        const testConfig = new TestConfig();
        const testCaseConfigurations = testConfig.generate();
        for (let cfg of testCaseConfigurations) {

            // Config.ProtocolsPerField is only relevant for multi-protocol configurations
            if (cfg.clientProtocols().length <= 1 && cfg.serverProtocols().length <= 1) {
                await this._runOne(cfg);
                continue;
            }

            if (Config.ProtocolsPerField === '1' || Config.ProtocolsPerField === 'ALL') {
                cfg.oneProtocolPerField = true;
                await this._runOne(cfg);
            }

            if (Config.ProtocolsPerField === 'all' || Config.ProtocolsPerField === 'ALL') {
                cfg.oneProtocolPerField = false;
                await this._runOne(cfg);
            }
        }
    }
}
