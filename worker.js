import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
globalThis.window = globalThis;

import {
  WalletContractV4,
  WalletContractV5R1,
  WalletContractV3R2
} from "@ton/ton";

import {
  mnemonicToPrivateKey,
  deriveEd25519Path,
  keyPairFromSeed
} from "@ton/crypto";

const TARGET =
  "UQD9eW663lS-7SeGVyYK_cQlKBSjzWSbxaBkgUTigTjZ9Hh6";

const CHECK_PATH =
  "/__wallet_derivation_check_739182";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      url.pathname === CHECK_PATH
    ) {
      return runWalletCheck(env);
    }

    return new Response(
      "PAYTON wallet derivation check is running!"
    );
  }
};

async function runWalletCheck(env) {
  try {
    if (!env.PTN_MNEMONIC) {
      return new Response(
        "ERROR: PTN_MNEMONIC secret is missing",
        { status: 500 }
      );
    }

    const words = env.PTN_MNEMONIC
      .trim()
      .split(/\s+/);

    const tonResult =
      await testTONMnemonic(words);

    const bip39Result =
      await testBIP39Mnemonic(words);

    let output =
`PAYTON WALLET DERIVATION CHECK

Target:
${TARGET}

Word count:
${words.length}

--------------------------------
TON MNEMONIC
--------------------------------

`;

    output += formatResults(tonResult);

    output +=
`

--------------------------------
BIP39 MULTICHAIN
--------------------------------

`;

    output += formatResults(bip39Result);

    const matches = [];

    for (const item of tonResult.items || []) {
      if (item.match) {
        matches.push(
          "TON MNEMONIC -> " + item.wallet
        );
      }
    }

    for (const item of bip39Result.items || []) {
      if (item.match) {
        matches.push(
          "BIP39 MULTICHAIN -> " + item.wallet
        );
      }
    }

    output +=
`

--------------------------------
FINAL RESULT
--------------------------------

`;

    if (matches.length > 0) {
      output +=
`MATCH FOUND

${matches.join("\n")}

The target address matches a tested derivation method.
`;
    } else {
      output +=
`NO MATCH FOUND

The tested derivation methods did not produce the target address.

No transaction was sent.
No mnemonic was displayed.
`;
    }

    return new Response(
      output,
      {
        headers: {
          "Content-Type":
            "text/plain; charset=UTF-8"
        }
      }
    );

  } catch (error) {
    console.error(error);

    return new Response(
      "ERROR\n\n" +
      String(error?.message || error),
      { status: 500 }
    );
  }
}

async function testTONMnemonic(words) {
  const group = {
    items: []
  };

  try {
    const keyPair =
      await mnemonicToPrivateKey(words);

    addWalletResult(
      group,
      "V5R1",
      createV5(keyPair.publicKey)
    );

    addWalletResult(
      group,
      "V4R2",
      createV4(keyPair.publicKey)
    );

    addWalletResult(
      group,
      "V3R2",
      createV3(keyPair.publicKey)
    );

  } catch (error) {
    group.error =
      String(error?.message || error);
  }

  return group;
}

async function testBIP39Mnemonic(words) {
  const group = {
    items: []
  };

  try {
    const seed =
      await bip39Seed(words);

    const derivedSeed =
      await deriveEd25519Path(
        seed,
        [44, 607, 0]
      );

    const keyPair =
      keyPairFromSeed(derivedSeed);

    addWalletResult(
      group,
      "V5R1",
      createV5(keyPair.publicKey)
    );

    addWalletResult(
      group,
      "V4R2",
      createV4(keyPair.publicKey)
    );

    addWalletResult(
      group,
      "V3R2",
      createV3(keyPair.publicKey)
    );

  } catch (error) {
    group.error =
      String(error?.message || error);
  }

  return group;
}

function createV5(publicKey) {
  return WalletContractV5R1.create({
    walletId: {
      networkGlobalId: -239
    },
    publicKey,
    workchain: 0
  });
}

function createV4(publicKey) {
  return WalletContractV4.create({
    workchain: 0,
    publicKey,
    walletId: 0x29a9a317
  });
}

function createV3(publicKey) {
  return WalletContractV3R2.create({
    workchain: 0,
    publicKey,
    walletId: 0
  });
}

function addWalletResult(
  group,
  wallet,
  contract
) {
  const address =
    contract.address.toString({
      bounceable: false,
      urlSafe: true
    });

  group.items.push({
    wallet,
    address,
    match: address === TARGET
  });
}

function formatResults(group) {
  let text = "";

  if (group.error) {
    text +=
`ERROR:
${group.error}
`;

    return text;
  }

  for (const item of group.items) {
    text +=
`${item.wallet}
${item.address}

`;

    if (item.match) {
      text +=
"*** MATCH ***\n\n";
    }
  }

  return text;
}

async function bip39Seed(words) {
  const mnemonic =
    words.join(" ").normalize("NFKD");

  const password =
    new TextEncoder().encode(mnemonic);

  const salt =
    new TextEncoder().encode(
      "mnemonic"
    );

  const key =
    await crypto.subtle.importKey(
      "raw",
      password,
      {
        name: "PBKDF2"
      },
      false,
      ["deriveBits"]
    );

  const bits =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-512",
        salt,
        iterations: 2048
      },
      key,
      512
    );

  return Buffer.from(bits);
    }
