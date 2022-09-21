// Daft-based Squid Tests
// Copyright (C) The Measurement Factory.
// http://www.measurement-factory.com/

// Tests whether an HTTP proxy parses a large stored HTTP response header

import assert from "assert";
import HttpTestCase from "../src/test/HttpCase";
import Body from "../src/http/Body";
import Resource from "../src/anyp/Resource";
import * as Config from "../src/misc/Config";
import * as AddressPool from "../src/misc/AddressPool";
import Test from "../src/overlord/Test";
import ConfigGen from "../src/test/ConfigGen";
import { RandomText } from "../src/misc/Gadgets";

/*
Squid reads a disk-stored entry by fixed-size data blocks.

Each entry starts with swap meta headers, followed by a stored HTTP message.
We need to know the swap meta headers size so that we could generate HTTP
header of the required length (e.g., occupying the rest of the first data block).

Though the swap meta header size depends on the response, we can calculate it for
known responses used in this test.

Swap meta headers in Squid are represented by the SwapMeta structure:

struct SwapMeta {
    struct Prefix {
        char magic;
        int swap_hdr_sz;
    };
    Prefix prefix;
    struct TLV {
        char type;
        int length;
        char value[length];
    };
    TLV fields[];
};

Responses generated in this test produce TLVs of 4 types.
We can calculate TLV::length for each of them:

STORE_META_KEY
    fixed 16-byte length
STORE_META_STD_LFS calculated as
    (4*sizeof(time_t)+2*sizeof(uint16_t)+sizeof(uint64_t) = 4*8 + 2*2 + 8 = 44
STORE_META_URL can be calculated for fixed-length URLs
    url.length() + 1 = 37 + 1 = 38 (37 is the length of the test-produced URLs like http://localhost:8080/path-94nsv9omj3)
STORE_META_OBJSIZE
    sizeof(int64_t) = 8

The length of the entire meta header is
sizeof(Prefix)+sizeof(fields) = 1+sizeof(int)+4*(1+sizeof(int))+16+44+38+8 = 5+20+16+44+38+8=131
*/
const SwapMetaHeaderSize = 131;

// Squid constant
const DataBlockSize = 4096;

// 64K Squid prefix limitation
const MaxBlock = 16;

Config.Recognize([
    {
        option: "data-blocks",
        type: "Number",
        description: `The number of Squid swap data blocks (${DataBlockSize} bytes each) that will be occupied by the response header`,
    },
    {
        option: "data-block-delta",
        type: "Number",
        description: "Allows to generate a header that will be less, equal to, or greater than the data blocks size",
    },
    {
        option: "cache-type",
        type: "String",
        enum: ["mem", "disk", "all"],
        description: "Turns on rock disk cache",
    },
    {
        option: "smp",
        type: "Boolean",
        default: "false",
        description: "In this mode MISS and HIT requests will go to different proxy SMP workers",
    },
]);

class TestConfig
{
    static PrefixSize(blocks, delta) {
        const firstBlock = DataBlockSize - SwapMetaHeaderSize;
        return firstBlock + DataBlockSize * (blocks - 1) + delta;
    }

    static DataBlocks() {
        if (Config.DataBlocks === undefined)
            return [1, 2, 8, 16];
        assert(Config.DataBlocks > 0);
        return [Config.DataBlocks];
    }

    static Deltas() {
        return Config.DataBlockDelta === undefined ? [-1, 0, 1] : [Config.DataBlockDelta];
    }

    static Prefixes() {
        let prefixes = [];
        for (let b of TestConfig.DataBlocks()) {
            assert(b <= MaxBlock);
            for (let d of TestConfig.Deltas()) {
                if (b === MaxBlock && d > 0)
                    continue;
                prefixes.push(TestConfig.PrefixSize(b, d));
            }
        }
        assert(prefixes.length > 0);
        return prefixes;
    }

    static Bodies() {
        return [0, Config.DefaultBodySize()];
    }

    static Ranges() {
        return ['none', 'low', 'med', 'high', 'any'];
    }

    static cacheType() { return [ 'mem', 'disk', 'all' ]; }

    static smpMode () { return [ false, true ]; }
}

export default class MyTest extends Test {

    _configureDut(cfg) {
        const memCache = Config.CacheType === 'mem' || Config.CacheType === 'all';
        const diskCache = Config.CacheType === 'disk' || Config.CacheType === 'all';
        cfg.memoryCaching(memCache);
        cfg.diskCaching(diskCache);
        if (Config.Smp) {
            cfg.workers(2);
            cfg.dedicatedWorkerPorts(true);
            this._workerListeningAddresses = cfg.workerListeningAddresses();
        }
    }

    static Configurators() {
        const configGen = new ConfigGen();

        configGen.addGlobalConfigVariation({prefixSize: TestConfig.Prefixes()});

        configGen.addGlobalConfigVariation({bodySize: TestConfig.Bodies()});

        configGen.addGlobalConfigVariation({range: TestConfig.Ranges()});

        configGen.addGlobalConfigVariation({cacheType: TestConfig.cacheType()});

        configGen.addGlobalConfigVariation({smp: TestConfig.smpMode()});

        return configGen.generateConfigurators();
    }

    // creates an array of range pairs from configuration
    makeRange() {
        const rangeName = Config.Range;
        const blocksNumber = 5;
        if (!rangeName || rangeName === 'none' || Config.BodySize < blocksNumber)
            return null
        const blockSize = Math.floor(Config.BodySize/blocksNumber);
        const blocks = {low: [0], med: [2], high: [4], any: [0, 2, 4]};
        const name = Object.keys(blocks).find(v => v === rangeName);
        assert(name);
        return blocks[name].map(block => [block*blockSize, (block+1)*blockSize - 1]);
    }

    // whether the two arrays are equal
    arraysAreEqual(a1, a2) {
        const isA1 = Array.isArray(a1);
        const isA2 = Array.isArray(a2);

        if ((!isA1 && isA2) || (isA1 && !isA2))
            return false;
        if (!isA1)
            return a1 === a2;
        if (a1.length !== a2.length)
            return false;
        for (let i=0; i < a1.length; ++i) {
            if (!this.arraysAreEqual(a1[i], a2[i]))
                return false;
        }
        return true;
    }

    async testRangeResponse() {
        const ranges = this.makeRange();
        if (!ranges)
            return;
        if (Config.Smp)
            return;
        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body(RandomText("body-", Config.BodySize), ranges);
        resource.finalize();

        let missCase = new HttpTestCase(`forward a response to a range request with ${Config.PrefixSize}-byte header and ${Config.BodySize}-byte body`);
        missCase.server().serve(resource);
        missCase.server().response.startLine.code(206);
        missCase.server().response.addRanges(ranges, Config.BodySize);
        missCase.client().request.for(resource);
        missCase.client().request.addRanges(ranges);

        missCase.addMissCheck();

        missCase.client().checks.add((client) => {
            client.expectStatusCode(206);
            const response = client.transaction().response;
            assert(this.arraysAreEqual(ranges, response.ranges));
        });

        missCase.server().checks.add((server) => {
            const request = server.transaction().request;
            assert(this.arraysAreEqual(ranges, request.parseRangeHeader()));
        });

        await missCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async testCaching() {
        let resource = new Resource();
        resource.makeCachable();
        resource.uri.address = AddressPool.ReserveListeningAddress();
        resource.body = new Body();
        resource.finalize();

        let missCase = new HttpTestCase(`forward a response with ${Config.PrefixSize}-byte header and ${Config.BodySize}-byte body`);
        missCase.server().serve(resource);
        missCase.client().request.for(resource);
        if (Config.Smp)
            missCase.client().nextHopAddress = this._workerListeningAddresses[1];
        missCase.addMissCheck();

        await missCase.run();

        await this.dut.finishCaching();

        const ranges = this.makeRange();
        const rangeDebugging = ranges ? 'with a range request' : '';
        let hitCase = new HttpTestCase(`hit a response ${rangeDebugging} with ${Config.PrefixSize}-byte header and ${Config.BodySize}-byte body`);
        hitCase.client().request.for(resource);
        if (Config.Smp)
            hitCase.client().nextHopAddress = this._workerListeningAddresses[2];
        if (ranges) {
            hitCase.client().request.addRanges(ranges);
            hitCase.client().checks.add((client) => {
                client.expectStatusCode(206);
                const response = client.transaction().response;
                assert(this.arraysAreEqual(ranges, response.ranges));
            });
        } else {
            hitCase.addHitCheck(missCase.server().transaction().response);
        }

        await hitCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run(/*testRun*/) {
        await this.testRangeResponse();
        await this.testCaching();
    }
}

