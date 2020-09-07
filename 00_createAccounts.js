const BCHJS = require("@psf/bch-js");
const fs = require("fs");

(async () => {
  // configs
  const walletName = process.argv[2] || "account.json";
  const NETWORK = `testnet`;
  const MAINNET_API_FREE = "https://free-main.fullstack.cash/v3/";
  const TESTNET_API_FREE = "https://free-test.fullstack.cash/v3/";
  const bchjs = new BCHJS({
    restURL: NETWORK === "mainnet" ? MAINNET_API_FREE : TESTNET_API_FREE,
  });

  // generate new account
  const mnemonic = bchjs.Mnemonic.generate();
  const rootSeed = await bchjs.Mnemonic.toSeed(mnemonic);
  const masterHDNode = bchjs.HDNode.fromSeed(rootSeed, NETWORK);
  const childNode = masterHDNode.derivePath(`m/44'/145'/0'/0/0`);

  // store info
  const outObj = {
    mnemonic,
    cashAddress: bchjs.HDNode.toCashAddress(childNode),
    slpAddress: bchjs.HDNode.toSLPAddress(childNode),
    legacyAddress: bchjs.HDNode.toLegacyAddress(childNode),
    WIF: bchjs.HDNode.toWIF(childNode),
  };
  fs.writeFile(walletName, JSON.stringify(outObj, null, 2), function (err) {
    if (err) return console.error(err);
    console.log(`${walletName} written successfully.`);
  });
})();
