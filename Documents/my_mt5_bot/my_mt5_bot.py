import MetaTrader5 as mt5
import pandas as pd
import time

# --- MT5 Account Details (USE A DEMO ACCOUNT FIRST!) ---
# DO NOT hardcode your live account password in production code.
# Use environment variables or secure configuration methods.
MT5_LOGIN = 210129682  # Your MT5 login ID
MT5_PASSWORD = "199129@Bere." # Your MT5 password
MT5_SERVER = "Exness-MT5Trial9" # Your Exness MT5 server name (e.g., "Exness-Main" or "Exness-Trial")
MT5_PATH = r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe" # Path to your MT5 terminal (Windows)

SYMBOL = "BTCUSDm" # Gold vs USD (mini) - adjust as per Exness symbols
LOT_SIZE = 0.1 # Standard lot size for forex/CFDs

def initialize_mt5():
    if not mt5.initialize(path=MT5_PATH, login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
        print(f"initialize() failed, error code: {mt5.last_error()}")
        return False
    print("MetaTrader5 initialized successfully.")
    return True

def get_market_data(symbol, timeframe, count):
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None:
        print(f"Failed to get rates for {symbol}, error code: {mt5.last_error()}")
        return pd.DataFrame()
    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    df.set_index('time', inplace=True)
    return df

def place_market_order(symbol, volume, type_of_order):
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5.ORDER_TYPE_BUY if type_of_order == "buy" else mt5.ORDER_TYPE_SELL,
        "price": mt5.symbol_info_tick(symbol).ask if type_of_order == "buy" else mt5.symbol_info_tick(symbol).bid,
        "deviation": 20, # Max price deviation in points
        "magic": 202306, # Unique ID for your bot's orders
        "comment": "Python Algo Trade",
        "type_time": mt5.ORDER_TIME_GTC, # Good Till Cancelled
        "type_filling": mt5.ORDER_FILLING_FOK, # Fill or Kill
    }

    # Check request validity
    check_result = mt5.order_check(request)
    if check_result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Order check failed: {check_result.comment}")
        return None

    # Send order
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Order send failed: {result.comment}")
        return None

    print(f"Order placed successfully: {result}")
    return result

def get_current_positions(symbol=None):
    positions = mt5.positions_get(symbol=symbol)
    if positions is None:
        print(f"No positions found, error code: {mt5.last_error()}")
        return []
    return positions

def close_position(ticket):
    position_info = mt5.positions_get(ticket=ticket)
    if not position_info:
        print(f"Position with ticket {ticket} not found.")
        return None

    position_info = position_info[0] # Get the first (and only) position found by ticket

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": position_info.symbol,
        "volume": position_info.volume,
        "type": mt5.ORDER_TYPE_SELL if position_info.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY,
        "position": position_info.ticket,
        "price": mt5.symbol_info_tick(position_info.symbol).bid if position_info.type == mt5.ORDER_TYPE_BUY else mt5.symbol_info_tick(position_info.symbol).ask,
        "deviation": 20,
        "magic": 202306,
        "comment": "Python Close Trade",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_RETURN, # Return remaining volume if cannot fill completely
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Close order failed: {result.comment}")
        return None
    print(f"Position {ticket} closed successfully: {result}")
    return result

# --- Main Trading Logic (Conceptual) ---
if __name__ == "__main__":
    if not initialize_mt5():
        exit()

    try:
        while True:
            # Get latest data
            df = get_market_data(SYMBOL, mt5.TIMEFRAME_M1, 100) # Get last 100 1-minute bars
            if df.empty:
                time.sleep(5)
                continue

            # Implement your strategy here (e.g., simple moving average crossover)
            df['SMA_Short'] = df['close'].rolling(window=10).mean()
            df['SMA_Long'] = df['close'].rolling(window=30).mean()

            # Check for signals based on the latest data
            # Ensure enough data for MA calculation (dropna) and then check last two bars
            if len(df.dropna()) >= 2:
                latest_short_ma = df['SMA_Short'].iloc[-1]
                prev_short_ma = df['SMA_Short'].iloc[-2]
                latest_long_ma = df['SMA_Long'].iloc[-1]
                prev_long_ma = df['SMA_Long'].iloc[-2]

                current_positions = get_current_positions(SYMBOL)
                has_long_position = any(p.type == mt5.ORDER_TYPE_BUY for p in current_positions)
                has_short_position = any(p.type == mt5.ORDER_TYPE_SELL for p in current_positions)

                # Buy signal (short MA crosses above long MA)
                if prev_short_ma < prev_long_ma and latest_short_ma > latest_long_ma:
                    if not has_long_position: # Only buy if no long position open
                        print(f"Buy signal for {SYMBOL} at {df['close'].iloc[-1]}")
                        place_market_order(SYMBOL, LOT_SIZE, "buy")
                    else:
                        print(f"Buy signal but already have a long position. Holding.")

                # Sell signal (short MA crosses below long MA)
                elif prev_short_ma > prev_long_ma and latest_short_ma < latest_long_ma:
                    if not has_short_position: # Only sell if no short position open
                        print(f"Sell signal for {SYMBOL} at {df['close'].iloc[-1]}")
                        place_market_order(SYMBOL, LOT_SIZE, "sell")
                    else:
                        print(f"Sell signal but already have a short position. Holding.")
            else:
                print("Not enough data for MA calculation. Waiting for more bars.")

            time.sleep(10) # Wait for 10 seconds before checking again (adjust as needed)

    except KeyboardInterrupt:
        print("Trading bot stopped by user.")
    finally:
        mt5.shutdown()
        print("MetaTrader5 connection shut down.")