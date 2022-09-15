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

Config.Recognize([
    {
        option: "data-blocks",
        type: "Number",
        description: `The number of Squid swap data blocks (${DataBlockSize} bytes each) that will be occupied by the response header`,
    },
    {
        option: "data-block-delta",
        type: "Number",
        description: "Allows to generate a header that will be ess, equal to, or greater than the data blocks size",
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
            return [1, 2];
        assert(Config.DataBlocks > 0);
        return [Config.DataBlocks];
    }

    static Deltas() {
        return Config.DataBlockDelta === undefined ? [-1, 0, 1] : [Config.DataBlockDelta];
    }

    static Prefixes() {
        let prefixes = [];
        for (let b of TestConfig.DataBlocks()) {
            for (let d of TestConfig.Deltas())
                prefixes.push(TestConfig.PrefixSize(b, d));
        }
        return prefixes;
    }

    static Bodies() {
        return [0, Config.DefaultBodySize()];
    }

    static Ranges() {
        if (Config.BodySize === 0)
            return [];
        let ranges = [];
        const count = 3;
        assert(Config.BodySize > count);
        const size = Math.floor(Config.BodySize/count);
        for (let i = 0; i < count; ++i) {
            const beg = i*size;
            const end = beg + size;
            ranges.push(`${beg}-${end}`);
        }
        return ranges;
    }
}

export default class MyTest extends Test {

    _configureDut(cfg) {
        cfg.memoryCaching(false);
        cfg.diskCaching(true);
    }

    static Configurators() {
        const configGen = new ConfigGen();

        configGen.addGlobalConfigVariation({prefixSize: TestConfig.Prefixes()});

        configGen.addGlobalConfigVariation({bodySize: TestConfig.Bodies()});

        configGen.addGlobalConfigVariation({range: TestConfig.Ranges()});

        return configGen.generateConfigurators();
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
        missCase.addMissCheck();
        await missCase.run();

        await this.dut.finishCaching();

        let hitCase = new HttpTestCase(`hit a response with ${Config.PrefixSize}-byte header and ${Config.BodySize}-byte body`);
        hitCase.client().request.for(resource);
        hitCase.client().request.setRanges();

        if (Config.Range) {
            hitCase.client().checks.add((client) => {
                client.expectStatusCode(206);
            });
        } else {
            hitCase.addHitCheck(missCase.server().transaction().response);
        }

        await hitCase.run();

        AddressPool.ReleaseListeningAddress(resource.uri.address);
    }

    async run(/*testRun*/) {
        await this.testCaching();
    }
}

