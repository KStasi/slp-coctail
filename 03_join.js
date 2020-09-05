// imports
const BigNumber = require("bignumber.js");
const BCHJS = require("@psf/bch-js");

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
const receiverWalletName = process.argv[4] || "account1.json";
const walletInfo0 = require("./" + walletName0);
const walletInfo1 = require("./" + walletName1);
const receiverInfo = require("./" + receiverWalletName);
const receiverSlpAddress = bchjs.SLP.Address.toSLPAddress(
  receiverInfo.cashAddress
);

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
  let addOpRet = true;
  let reminders = [];
  for (let i = 0; i < cashAddresses.length; i++) {
    let cashAddress = cashAddresses[i];
    let receiverSlpAddress = receiverSlpAddresses[i];
    // fetch all utxo
    const data = await bchjs.Electrumx.utxo(cashAddress);
    const utxos = data.utxos;
    // console.log(`utxos: ${JSON.stringify(utxos, null, 2)}`);

    if (utxos.length === 0) throw new Error("No UTXOs to spend! Exiting.");

    let allUtxos = await bchjs.SLP.Utils.tokenUtxoDetails(utxos);
    // console.log(`tokenUtxos: ${JSON.stringify(allUtxos, null, 2)}`);

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

    // Generate the OP_RETURN code.
    const slpSendObj = bchjs.SLP.TokenType1.generateSendOpReturn(
      tokenUtxos,
      amount
    );
    const slpData = slpSendObj.script;

    // find bch utxo for fee
    const bchUtxo = findUtxo(bchUtxos, txFee);
    // console.log(`bchUtxo: ${JSON.stringify(bchUtxo, null, 2)}`);

    // add inputs
    transactionBuilder.addInput(bchUtxo.tx_hash, bchUtxo.tx_pos);
    for (let i = 0; i < tokenUtxos.length; i++) {
      transactionBuilder.addInput(tokenUtxos[i].tx_hash, tokenUtxos[i].tx_pos);
    }
    // add OP_RETURN
    if (addOpRet) {
      transactionBuilder.addOutput(slpData, 0);
      addOpRet = false;
    }

    // add outouts
    transactionBuilder.addOutput(
      bchjs.SLP.Address.toLegacyAddress(receiverSlpAddress),
      546
    );
    if (slpSendObj.outputs > 1) {
      transactionBuilder.addOutput(
        bchjs.SLP.Address.toLegacyAddress(cashAddress),
        546
      );
    }
    reminders.push([
      bchjs.Address.toLegacyAddress(cashAddress),
      bchUtxo.value - txFee,
    ]);
  }

  reminders.forEach((reminder) => {
    transactionBuilder.addOutput(reminder[0], reminder[1]);
  });
  console.log(JSON.stringify(transactionBuilder, null, 2));
}

async function joinTokens() {
  try {
    await prepareTransaction(
      [walletInfo0.cashAddress, walletInfo1.cashAddress],
      [walletInfo1.cashAddress, walletInfo0.cashAddress],
      TOKENQTY,
      TOKENID,
      250 + 546 * 2
    );

    // // Sign the transaction with the private key for the BCH UTXO paying the fees.
    // let redeemScript;
    // transactionBuilder.sign(
    //   0,
    //   keyPair,
    //   redeemScript,
    //   transactionBuilder.hashTypes.SIGHASH_ALL,
    //   originalAmount
    // );
    // // Sign each token UTXO being consumed.
    // for (let i = 0; i < tokenUtxos.length; i++) {
    //   const thisUtxo = tokenUtxos[i];
    //   transactionBuilder.sign(
    //     1 + i,
    //     keyPair,
    //     redeemScript,
    //     transactionBuilder.hashTypes.SIGHASH_ALL,
    //     thisUtxo.value
    //   );
    // }
    // // build tx
    // const tx = transactionBuilder.build();
    // // output rawhex
    // const hex = tx.toHex();
    // // console.log(`Transaction raw hex: `, hex)
    // // END transaction construction.
    // // Broadcast transation to the network
    // const txidStr = await bchjs.RawTransactions.sendRawTransaction([hex]);
    // console.log(`Transaction ID: ${txidStr}`);
    // console.log("Check the status of your transaction on this block explorer:");
    // if (NETWORK === "testnet") {
    //   console.log(`https://explorer.bitcoin.com/tbch/tx/${txidStr}`);
    // } else console.log(`https://explorer.bitcoin.com/bch/tx/${txidStr}`);
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
