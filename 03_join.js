// imports
const BigNumber = require("bignumber.js");
const BCHJS = require("@psf/bch-js");
const slpMdm = require("slp-mdm");

// network
const NETWORK = `testnet`;
const MAINNET_API_FREE = "https://free-main.fullstack.cash/v3/";
const TESTNET_API_FREE = "https://free-test.fullstack.cash/v3/";
let bchjs = new BCHJS({
  restURL: NETWORK === "mainnet" ? MAINNET_API_FREE : TESTNET_API_FREE,
});

// accounts
const walletName0 = process.argv[2] || "account0.json";
const walletName1 = process.argv[3] || "account1.json";
const receiverWalletName0 = process.argv[4] || "account2.json";
const receiverWalletName1 = process.argv[4] || "account3.json";
const walletInfo0 = require("./" + walletName0);
const walletInfo1 = require("./" + walletName1);
const receiverInfo0 = require("./" + receiverWalletName0);
const receiverInfo1 = require("./" + receiverWalletName1);

// token
const TOKENQTY = 1;
const TOKENID =
  "20fdfb9fa450af19716f5b8df8634db594a5327930614ba6cd9f15e179f4913d";
async function prepareTransaction(
  cashAddresses,
  receiverSlpAddresses,
  amount,
  tokenId,
  txFee
) {
  let transactionBuilder = new bchjs.TransactionBuilder(NETWORK);
  let insInfo = cashAddresses.reduce((a, b) => ((a[b] = []), a), {});
  let addOpRet = true;
  let reminders = [];
  let commonTokenUtxo = [];
  let changes = [];
  let ix = 0;
  for (let i = 0; i < cashAddresses.length; i++) {
    let cashAddress = cashAddresses[i];

    // fetch all utxo
    const data = await bchjs.Electrumx.utxo(cashAddress);
    const utxos = data.utxos;

    if (utxos.length === 0) throw new Error("No UTXOs to spend! Exiting.");

    let allUtxos = await bchjs.SLP.Utils.tokenUtxoDetails(utxos);

    // filter bch utxos
    const bchUtxos = utxos.filter((utxo, index) => {
      const tokenUtxo = allUtxos[index];
      if (!tokenUtxo.isValid) return true;
    });

    if (bchUtxos.length === 0) {
      throw new Error("Wallet does not have a BCH UTXO to pay miner fees.");
    }

    // filter token Utxos
    const tokenUtxos = allUtxos.filter((utxo, index) => {
      if (utxo && utxo.tokenId === tokenId && utxo.utxoType === "token") {
        return true;
      }
    });
    if (tokenUtxos.length === 0) {
      throw new Error("No token UTXOs for the specified token could be found.");
    }

    // collect all tokens
    commonTokenUtxo = commonTokenUtxo.concat(tokenUtxos);

    // calculate token change
    let totalTokens = 0;
    for (let i = 0; i < tokenUtxos.length; i++)
      totalTokens += tokenUtxos[i].tokenQty;
    const change = totalTokens - amount;
    changes.push(change);

    // find bch utxo for fee
    const bchUtxo = findUtxo(bchUtxos, txFee);

    // add inputs
    transactionBuilder.addInput(bchUtxo.tx_hash, bchUtxo.tx_pos);
    insInfo[cashAddress].push({ index: ix++, amount: bchUtxo.value });
    for (let i = 0; i < tokenUtxos.length; i++) {
      transactionBuilder.addInput(tokenUtxos[i].tx_hash, tokenUtxos[i].tx_pos);
      insInfo[cashAddress].push({ index: ix++, amount: tokenUtxos[i].value });
    }

    // calculate BCH change
    reminders.push([
      bchjs.Address.toLegacyAddress(cashAddress),
      bchUtxo.value - txFee,
    ]);
  }

  // generate op return script
  const slpSendObj = generateSendOpReturn(
    commonTokenUtxo,
    Array(receiverSlpAddresses.length).fill(amount).concat(changes)
  );
  const slpData = slpSendObj.script;

  // add OP_RETURN
  transactionBuilder.addOutput(slpData, 0);
  addOpRet = false;

  // add outouts to receivers
  receiverSlpAddresses.forEach((receiverSlpAddress) => {
    transactionBuilder.addOutput(
      bchjs.SLP.Address.toLegacyAddress(receiverSlpAddress),
      546
    );
  });

  // add outouts with token change
  cashAddresses.forEach((cashAddress) => {
    transactionBuilder.addOutput(
      bchjs.SLP.Address.toLegacyAddress(cashAddress),
      546
    );
  });

  // add outouts with BCH change
  reminders.forEach((reminder) => {
    transactionBuilder.addOutput(reminder[0], reminder[1]);
  });
  return [transactionBuilder, insInfo];
}

function generateSendOpReturn(tokenUtxos, sendQtys) {
  try {
    const tokenId = tokenUtxos[0].tokenId;
    const decimals = tokenUtxos[0].decimals;

    let totalTokens = 0;
    let sendQty = 0;
    for (let i = 0; i < tokenUtxos.length; i++)
      totalTokens += tokenUtxos[i].tokenQty;
    for (let i = 0; i < sendQtys.length; i++) sendQty += sendQtys[i];

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
  } catch (err) {
    console.log(`Error in generateSendOpReturn()`);
    throw err;
  }
}

function signTransaction(transactionBuilder, keyPair, insInfo) {
  insInfo.forEach((inInfo) => {
    let redeemScript;
    transactionBuilder.sign(
      inInfo.index,
      keyPair,
      redeemScript,
      transactionBuilder.hashTypes.SIGHASH_ALL,
      inInfo.amount
    );
  });
  return transactionBuilder;
}

async function joinTokens() {
  try {
    let [transactionBuilder, insInfo] = await prepareTransaction(
      [walletInfo0.cashAddress, walletInfo1.cashAddress],
      [receiverInfo0.cashAddress, receiverInfo1.cashAddress],
      TOKENQTY,
      TOKENID,
      250 + 546 * 2
    );
    const keyPair0 = bchjs.ECPair.fromWIF(walletInfo0.WIF);
    const keyPair1 = bchjs.ECPair.fromWIF(walletInfo1.WIF);
    transactionBuilder = signTransaction(
      transactionBuilder,
      keyPair0,
      insInfo[walletInfo0.cashAddress]
    );

    transactionBuilder = signTransaction(
      transactionBuilder,
      keyPair1,
      insInfo[walletInfo1.cashAddress]
    );

    const tx = transactionBuilder.build();
    const hex = tx.toHex();
    console.log(`Transaction raw hex: `, hex);

    const txidStr = await bchjs.RawTransactions.sendRawTransaction([hex]);
    console.log(`Transaction ID: ${txidStr}`);
    console.log(
      `https://explorer.bitcoin.com/${
        NETWORK === "testnet" ? "tbch" : "tbch"
      }/tx/${txidStr}`
    );
  } catch (err) {
    console.error("Error in sendToken: ", err);
    console.log(`Error message: ${err.message}`);
  }
}

function findUtxo(utxos, amount) {
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

joinTokens();
