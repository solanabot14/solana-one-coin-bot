const fs = require("fs");
const DATA_FILE = "./tradingData.json";

const STARTING_BALANCE = 100;

let balance = STARTING_BALANCE;
let position = null;
let history = [];
function saveData() {
  const data = {
    startingBalance: STARTING_BALANCE,
    cashBalance: balance,
    position: position,
    history: history
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Load trading data from file
if (fs.existsSync(DATA_FILE)) {
  const data = fs.readFileSync(DATA_FILE, "utf8");
  const jsonData = JSON.parse(data);
  balance = jsonData.cashBalance;
  position = jsonData.position;
  history = jsonData.history;
}

function buy(coin) {
	if (position) {
		return {
			success: false,
			message: "Ya existe una moneda activa."
		};
	}

	const price = Number(coin.priceUsd);

	if (!price || price <= 0) {
		return {
			success: false,
			message: "Precio inválido."
		};
	}

	// Invest only $10 per trade
const amountInvested = Math.min(10, balance);
const quantity = amountInvested / price;

	position = {
		symbol: coin.symbol,
		name: coin.name,
		tokenAddress: coin.tokenAddress,
		entryPrice: price,
		quantity,
		amountInvested,
        firstTakeProfitDone: false,
        secondTakeProfitDone: false,
        highestPrice: price,
		entryTime: new Date().toISOString()
	};

	balance -= amountInvested;

	const trade = {
		type: "BUY",
		...position
	};

	history.push(trade);
    saveData();

	return {
		success: true,
		trade
	};
}
function sell(currentPrice, percentToSell = 100) {
  if (!position) {
    return {
      success: false,
      message: "No hay ninguna posición abierta."
    };
  }

  currentPrice = Number(currentPrice);

  if (!currentPrice || currentPrice <= 0) {
    return {
      success: false,
      message: "Precio de venta inválido."
    };
  }

  if (percentToSell <= 0 || percentToSell > 100) {
    return {
      success: false,
      message: "Porcentaje de venta inválido."
    };
  }

  const quantitySold = position.quantity * (percentToSell / 100);
  const costBasisSold = position.amountInvested * (percentToSell / 100);
  const saleValue = quantitySold * currentPrice;

  const pnl = saleValue - costBasisSold;
  const pnlPercent = (pnl / costBasisSold) * 100;

  const trade = {
    type: "SELL",
    symbol: position.symbol,
    name: position.name,
    tokenAddress: position.tokenAddress,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    percentSold: percentToSell,
    quantitySold,
    amountInvested: costBasisSold,
    saleValue,
    pnl,
    pnlPercent,
    entryTime: position.entryTime,
    exitTime: new Date().toISOString()
  };

  balance += saleValue;

  position.quantity -= quantitySold;
  position.amountInvested -= costBasisSold;

  if (position.quantity <= 0.000000001 || percentToSell === 100) {
    position = null;
  }

  history.push(trade);
  saveData();

  return {
    success: true,
    trade
  };
}
function getPortfolio() {
	return {
		startingBalance: STARTING_BALANCE,
		cashBalance: balance,
        

		position,
		history

    };
}
module.exports = {
    buy,
    sell,
    getPortfolio
};