const BigNumber = require("bignumber.js");
const BCHJS = require("@psf/bch-js");
const slpMdm = require("slp-mdm");

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
const walletName0 = process.argv[3] || "account0.json";
const walletName1 = process.argv[4] || "account1.json";
const receiverWalletName0 = process.argv[5] || "account2.json";
const receiverWalletName1 = process.argv[6] || "account3.json";
const walletInfo0 = require("./" + walletName0);
const walletInfo1 = require("./" + walletName1);
const receiverInfo0 = require("./" + receiverWalletName0);
const receiverInfo1 = require("./" + receiverWalletName1);

(async () => {
  // accounts
  const cashAddresses = [walletInfo0.cashAddress, walletInfo1.cashAddress];
  const receiverSlpAddresses = [
    receiverInfo0.cashAddress,
    receiverInfo1.cashAddress,
  ];

  // config fees and dust
  const txFee = 1000;
  const dustPerOutput = 550;
  const totalSpent = txFee + 2 * dustPerOutput;

  // prepare variables
  const transactionBuilder = new bchjs.TransactionBuilder(NETWORK);
  let insInfo = cashAddresses.reduce((a, b) => ((a[b] = []), a), {});
  let reminders = [];
  let commonTokenUtxo = [];
  let changes = [];
  let ix = 0;

  // for every token sender
  for (let i = 0; i < cashAddresses.length; i++) {
    let cashAddress = cashAddresses[i];

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
    const bchUtxo = await findUtxo(bchUtxos, totalSpent);

    // add inputs
    transactionBuilder.addInput(bchUtxo.tx_hash, bchUtxo.tx_pos);
    insInfo[cashAddress].push({ index: ix++, amount: bchUtxo.value });
    for (let i = 0; i < tokenUtxos.length; i++) {
      transactionBuilder.addInput(tokenUtxos[i].tx_hash, tokenUtxos[i].tx_pos);
      insInfo[cashAddress].push({ index: ix++, amount: tokenUtxos[i].value });
    }

    // collect all outputs
    commonTokenUtxo = commonTokenUtxo.concat(tokenUtxos);
    let totalTokens = 0;
    for (let i = 0; i < tokenUtxos.length; i++) {
      totalTokens += tokenUtxos[i].tokenQty;
    }
    const change = totalTokens - tokenQty;
    changes.push(change);
    reminders.push([
      bchjs.Address.toLegacyAddress(cashAddress),
      bchUtxo.value - txFee,
    ]);
  }

  // add outputs
  const slpSendObj = generateSendOpReturn(
    commonTokenUtxo,
    Array(receiverSlpAddresses.length).fill(tokenQty).concat(changes)
  );
  const script = slpSendObj.script;
  transactionBuilder.addOutput(script, 0);
  receiverSlpAddresses.forEach((receiverSlpAddress) => {
    transactionBuilder.addOutput(
      bchjs.SLP.Address.toLegacyAddress(receiverSlpAddress),
      dustPerOutput
    );
  });
  cashAddresses.forEach((cashAddress) => {
    transactionBuilder.addOutput(
      bchjs.SLP.Address.toLegacyAddress(cashAddress),
      dustPerOutput
    );
  });
  reminders.forEach((reminder) => {
    transactionBuilder.addOutput(...reminder);
  });

  // sign
  const keyPair0 = bchjs.ECPair.fromWIF(walletInfo0.WIF);
  const keyPair1 = bchjs.ECPair.fromWIF(walletInfo1.WIF);

  // sign by user 0
  insInfo[walletInfo0.cashAddress].forEach((inInfo) => {
    let redeemScript;
    transactionBuilder.sign(
      inInfo.index,
      keyPair0,
      redeemScript,
      transactionBuilder.hashTypes.SIGHASH_ALL,
      inInfo.amount
    );
  });

  // sign by user 1
  insInfo[walletInfo1.cashAddress].forEach((inInfo) => {
    let redeemScript;
    transactionBuilder.sign(
      inInfo.index,
      keyPair1,
      redeemScript,
      transactionBuilder.hashTypes.SIGHASH_ALL,
      inInfo.amount
    );
  });
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

function generateSendOpReturn(tokenUtxos, sendQtys) {
  // token data
  const tokenId = tokenUtxos[0].tokenId;
  const decimals = tokenUtxos[0].decimals;

  // compare
  let totalTokens = 0;
  let sendQty = 0;
  for (let i = 0; i < tokenUtxos.length; i++) {
    totalTokens += tokenUtxos[i].tokenQty;
  }
  for (let i = 0; i < sendQtys.length; i++) {
    sendQty += sendQtys[i];
  }
  if (totalTokens < sendQty) {
    throw new Error(`Wallet does not have a SLP UTXO to pay.`);
  }

  let script;
  let amounts = [];
  sendQtys.forEach((sendQty) => {
    let baseQty = new BigNumber(sendQty).times(10 ** decimals);
    baseQty = baseQty.absoluteValue();
    baseQty = Math.floor(baseQty);
    baseQty = baseQty.toString();
    amounts.push(new slpMdm.BN(baseQty));
  });

  script = slpMdm.TokenType1.send(tokenId, amounts);
  return { script, outputs: sendQtys.length };
}
