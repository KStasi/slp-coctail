const BigNumber = require("bignumber.js");
const BCHJS = require("@psf/bch-js");
let Utils = require("slpjs").Utils;

// bchjs configs
const NETWORK = `testnet`;
const MAINNET_API_FREE = "https://free-main.fullstack.cash/v3/";
const TESTNET_API_FREE = "https://free-test.fullstack.cash/v3/";
const bchjs = new BCHJS({
  restURL: NETWORK === "mainnet" ? MAINNET_API_FREE : TESTNET_API_FREE,
});

// token configs
const tokenQty = 10;
const tokenId =
  process.argv[2] ||
  "20fdfb9fa450af19716f5b8df8634db594a5327930614ba6cd9f15e179f4913d";

// wallet configs
const walletName = process.argv[3] || "account0.json";
const receiverWalletName = process.argv[4] || "account1.json";
const walletInfo = require("./" + walletName);
const receiverInfo = require("./" + receiverWalletName);

(async () => {
  // account info
  const rootSeed = await bchjs.Mnemonic.toSeed(walletInfo.mnemonic);
  const masterHDNode = bchjs.HDNode.fromSeed(rootSeed, NETWORK);
  const account = masterHDNode.derivePath(`m/44'/145'/0'/0/0`);
  const cashAddress = bchjs.HDNode.toCashAddress(account);
  const slpAddress = bchjs.HDNode.toSLPAddress(account);
  const receiverAddress = Utils.toSlpAddress(receiverInfo.cashAddress);

  // config fees and dust
  const txFee = 550;
  const dustPerOutput = 550;
  const totalSpent = txFee + 2 * dustPerOutput;

  // chose utxo
  const data = await bchjs.Electrumx.utxo(cashAddress);
  const utxos = data.utxos;
  if (utxos.length === 0) throw new Error("No UTXOs to spend! Exiting.");

  let allUtxos = await bchjs.SLP.Utils.tokenUtxoDetails(utxos);

  const bchUtxos = utxos.filter((utxo, index) => {
    const tokenUtxo = allUtxos[index];
    if (!tokenUtxo.isValid) return true;
  });
  if (bchUtxos.length === 0) {
    throw new Error("Wallet does not have a BCH UTXO to pay miner fees.");
  }
  const tokenUtxos = allUtxos.filter((utxo, index) => {
    if (utxo && utxo.tokenId === tokenId && utxo.utxoType === "token") {
      return true;
    }
  });
  if (tokenUtxos.length === 0) {
    throw new Error("No token UTXOs for the specified token could be found.");
  }
  const bchUtxo = await findUtxo(utxos, totalSpent);

  // instance of transaction builder
  const transactionBuilder = new bchjs.TransactionBuilder(NETWORK);

  // add inputs
  const slpSendObj = bchjs.SLP.TokenType1.generateSendOpReturn(
    tokenUtxos,
    tokenQty
  );
  const slpData = slpSendObj.script;
  transactionBuilder.addInput(bchUtxo.tx_hash, bchUtxo.tx_pos);
  for (let i = 0; i < tokenUtxos.length; i++) {
    transactionBuilder.addInput(tokenUtxos[i].tx_hash, tokenUtxos[i].tx_pos);
  }

  const remainder = bchUtxo.value - totalSpent;
  if (remainder < 1) {
    throw new Error("Selected UTXO does not have enough satoshis");
  }

  // add outputs
  transactionBuilder.addOutput(slpData, 0);
  transactionBuilder.addOutput(
    bchjs.SLP.Address.toLegacyAddress(receiverAddress),
    dustPerOutput
  );
  if (slpSendObj.outputs > 1) {
    transactionBuilder.addOutput(
      bchjs.SLP.Address.toLegacyAddress(slpAddress),
      dustPerOutput
    );
  }
  transactionBuilder.addOutput(
    bchjs.Address.toLegacyAddress(cashAddress),
    remainder
  );

  // sign
  const keyPair = bchjs.HDNode.toKeyPair(account);
  let redeemScript;
  transactionBuilder.sign(
    0,
    keyPair,
    redeemScript,
    transactionBuilder.hashTypes.SIGHASH_ALL,
    bchUtxo.value
  );
  for (let i = 0; i < tokenUtxos.length; i++) {
    const thisUtxo = tokenUtxos[i];

    transactionBuilder.sign(
      1 + i,
      keyPair,
      redeemScript,
      transactionBuilder.hashTypes.SIGHASH_ALL,
      thisUtxo.value
    );
  }
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
})().catch(console.log);

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
