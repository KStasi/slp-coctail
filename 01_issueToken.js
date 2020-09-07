const BCHJS = require("@psf/bch-js");

// bchjs configs
const NETWORK = `testnet`;
const MAINNET_API_FREE = "https://free-main.fullstack.cash/v3/";
const TESTNET_API_FREE = "https://free-test.fullstack.cash/v3/";
const bchjs = new BCHJS({
  restURL: NETWORK === "mainnet" ? MAINNET_API_FREE : TESTNET_API_FREE,
});

// token configs
const decimals = 2;
const name = "Cocktail token";
const ticker = "COCK";
const documentUrl = "info@coctail.io";
const documentHash = null;
const initialTokenQty = 1000000;

// wallet configs
const walletName = process.argv[2] || "account.json";
const walletInfo = require("./" + walletName);

(async () => {
  // account info
  const rootSeed = await bchjs.Mnemonic.toSeed(walletInfo.mnemonic);
  const masterHDNode = bchjs.HDNode.fromSeed(rootSeed, NETWORK);
  const account = masterHDNode.derivePath(`m/44'/145'/0'/0/0`);
  const cashAddress = bchjs.HDNode.toCashAddress(account);

  // config fees and dust
  const txFee = 550;
  const dustPerOutput = 550;
  const totalSpent = txFee + 2 * dustPerOutput;

  // chose utxo
  const data = await bchjs.Electrumx.utxo(cashAddress);
  const utxos = data.utxos;
  if (utxos.length === 0) {
    throw new Error("No UTXOs to pay for transaction! Exiting.");
  }
  const utxo = await findUtxo(utxos, totalSpent);

  // instance of transaction builder
  const transactionBuilder = new bchjs.TransactionBuilder(NETWORK);

  // add inputs
  transactionBuilder.addInput(utxo.tx_hash, utxo.tx_pos);
  const remainder = utxo.value - totalSpent;

  // add outputs
  const script = bchjs.SLP.TokenType1.generateGenesisOpReturn({
    name,
    ticker,
    documentUrl,
    decimals,
    initialQty: initialTokenQty,
    documentHash,
    mintBatonVout: 2,
  });
  transactionBuilder.addOutput(script, 0);
  transactionBuilder.addOutput(
    bchjs.Address.toLegacyAddress(cashAddress),
    dustPerOutput
  );
  transactionBuilder.addOutput(
    bchjs.Address.toLegacyAddress(cashAddress),
    dustPerOutput
  );
  transactionBuilder.addOutput(cashAddress, remainder);

  // sign
  const keyPair = bchjs.HDNode.toKeyPair(account);
  let redeemScript;
  transactionBuilder.sign(
    0,
    keyPair,
    redeemScript,
    transactionBuilder.hashTypes.SIGHASH_ALL,
    utxo.value
  );
  const tx = transactionBuilder.build();
  const hex = tx.toHex();
  console.log(`Transaction raw hex: `, hex);

  // broadcast
  const txidStr = await bchjs.RawTransactions.sendRawTransaction([hex]);
  console.log(`Transaction ID: ${txidStr}`);
  console.log(
    `https://explorer.bitcoin.com/${
      NETWORK == "testnet" ? "tbch" : "bch"
    }/tx/${txidStr}`
  );
})();

async function findUtxo(utxos, amount) {
  utxos.sort((a, b) => {
    if (a.value < b.value) {
      return -1;
    }
    if (a.value > b.value) {
      return 1;
    }
    return 0;
  });

  for (let i = 0; i < utxos.length; i++) {
    if (utxos[i].value >= amount) {
      return utxos[i];
    }
  }
  throw new Error(`Wallet does not have a BCH UTXO to pay.`);
}
