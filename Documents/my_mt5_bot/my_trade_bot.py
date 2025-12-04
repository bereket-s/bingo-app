# 1. Import necessary libraries
import MetaTrader5 as mt5 # The official MT5 Python API
import pandas as pd      # For data manipulation (especially for historical bars)
import time              # For pausing execution (e.g., waiting between checks)
import datetime          # Useful for timestamps and logging

# --- 2. Configuration Parameters ---
# IMPORTANT: For live trading, DO NOT hardcode sensitive information like passwords.
# For testing, ALWAYS use a demo account.

# Your MT5 account login, password, and server name from Exness
# You can find the server name in your MT5 Navigator window when logged in.
MT5_LOGIN = 210129682 # Replace with your MT5 login ID (e.g., from Exness demo account)
MT5_PASSWORD = "199129@Bere." # Replace with your MT5 password
MT5_SERVER = "Exness-MT5Trial9" # Replace with your Exness MT5 server name (e.g., "Exness-Real", "Exness-Demo")

# Path to your MetaTrader 5 terminal executable (terminal64.exe or terminal.exe)
# Adjust this path based on your operating system and MT5 installation location.
# Use 'r' before the string (raw string) for Windows paths to handle backslashes correctly.
MT5_PATH = r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe" # Example Windows Path

# Trading parameters
SYMBOL = "XAUUSDm" # The trading instrument (e.g., "EURUSD", "XAUUSDm" for Gold mini)
LOT_SIZE = 0.01 # Volume/Lot size for trades. Adjust this carefully based on your account size and risk tolerance.
MAGIC_NUMBER = 20240531 # A unique identifier for your bot's orders. This helps you distinguish trades placed by your bot from manual trades or other bots.

# Strategy parameters (for a simple Moving Average Crossover)
SHORT_MA_PERIOD = 10   # Period for the short moving average
LONG_MA_PERIOD = 30    # Period for the long moving average
TIMEFRAME = mt5.TIMEFRAME_M1 # Timeframe for historical data (e.g., M1 for 1-minute bars, H1 for 1-hour, D1 for daily)
BAR_COUNT = 100        # Number of historical bars to fetch for analysis


# --- MT5 Connection and Data Functions ---

def initialize_mt5_connection():
    """Initializes the MetaTrader 5 connection."""
    print("Attempting to initialize MetaTrader 5 connection...")
    # mt5.initialize() connects to the MT5 terminal.
    # We pass the path to the terminal executable and account credentials.
    if not mt5.initialize(path=MT5_PATH, login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
        print(f"MT5 initialize() failed, error code: {mt5.last_error()}")
        return False # Return False on failure
    print("MetaTrader 5 initialized successfully.")
    return True # Return True on success

def shutdown_mt5_connection():
    """Shuts down the MetaTrader 5 connection."""
    print("Shutting down MetaTrader 5 connection...")
    mt5.shutdown() # Disconnects the Python script from MT5
    print("MetaTrader 5 connection shut down.")

def get_historical_data(symbol, timeframe, count):
    """
    Fetches historical OHLCV data (candlestick bars) for a given symbol and timeframe.
    Returns a pandas DataFrame.
    """
    # mt5.copy_rates_from_pos(symbol, timeframe, start_position, count)
    # - symbol: The trading instrument.
    # - timeframe: The period of each bar (e.g., M1, H1).
    # - start_position: 0 means starting from the latest bar.
    # - count: Number of bars to retrieve.
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None:
        print(f"Failed to get rates for {symbol} ({mt5.timeframe_to_string(timeframe)}), error code: {mt5.last_error()}")
        return pd.DataFrame() # Return an empty DataFrame on error

    # Convert the retrieved data (which is a numpy array) into a pandas DataFrame
    df = pd.DataFrame(rates)
    # Convert Unix timestamp to readable datetime objects
    df['time'] = pd.to_datetime(df['time'], unit='s')
    # Set the 'time' column as the DataFrame index for easier time-series analysis
    df.set_index('time', inplace=True)
    return df

def get_current_tick(symbol):
    """Fetches the current tick data (bid, ask, last price, volume, etc.)."""
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        print(f"Failed to get tick info for {symbol}, error code: {mt5.last_error()}")
        return None # Return None on error
    return tick


# --- Trading Functions ---

def send_order(symbol, volume, order_type, price=None, sl=0.0, tp=0.0, deviation=20, comment="Python Algo Trade"):
    """
    Sends a trading order to MT5.
    order_type: mt5.ORDER_TYPE_BUY or mt5.ORDER_TYPE_SELL
    price: Required for limit/stop orders, optional for market orders (uses current bid/ask)
    sl: Stop Loss price (0.0 for no SL) - IMPORTANT FOR RISK MANAGEMENT!
    tp: Take Profit price (0.0 for no TP)
    """
    # If no price is specified for a market order, get the current bid/ask
    if price is None:
        tick = get_current_tick(symbol)
        if tick is None:
            print(f"Could not get current tick for {symbol} to determine price.")
            return None
        price = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid # Use ask for buy, bid for sell

    # Construct the order request dictionary
    request = {
        "action": mt5.TRADE_ACTION_DEAL, # This specifies an instant execution (market) order
        "symbol": symbol,
        "volume": volume,
        "type": order_type, # BUY or SELL
        "price": price,
        "deviation": deviation, # Max allowed price deviation (in points) from the requested price for market orders
        "sl": sl, # Stop Loss price
        "tp": tp, # Take Profit price
        "magic": MAGIC_NUMBER, # Your bot's unique ID
        "comment": comment, # A comment that appears in your MT5 history
        "type_time": mt5.ORDER_TIME_GTC, # Good Till Cancelled (order remains active until filled or cancelled)
        "type_filling": mt5.ORDER_FILLING_FOK, # Fill Or Kill (either the entire volume is filled, or the order is cancelled)
    }

    # IMPORTANT: Always check the request for validity before sending
    # This prevents sending invalid orders that would be rejected by the broker.
    check_result = mt5.order_check(request)
    if check_result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Order check failed: {check_result.comment} (Retcode: {check_result.retcode})")
        return None # Return None if the order request is invalid

    # Send the order to MT5
    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Order send failed: {result.comment} (Retcode: {result.retcode})")
        # Print more details about the rejected request if available
        if result.request:
            print(f"Request details: {result.request}")
        return None # Return None if the order sending failed

    print(f"Order placed successfully: {result.comment}")
    print(f"Order ticket: {result.order}, Position ticket: {result.deal}")
    return result # Return the result object on success

def get_open_positions(symbol=None):
    """
    Retrieves all open positions, or positions for a specific symbol.
    Returns a tuple of position objects.
    """
    positions = mt5.positions_get(symbol=symbol)
    if positions is None:
        print(f"No positions found or error getting positions: {mt5.last_error()}")
        return [] # Return an empty list on error or no positions
    return positions

def close_position(position_ticket):
    """
    Closes a specific open position by its ticket number.
    """
    position_info = mt5.positions_get(ticket=position_ticket)
    if not position_info:
        print(f"Position with ticket {position_ticket} not found or already closed.")
        return None

    position_info = position_info[0] # mt5.positions_get returns a tuple, get the first (and only) position

    # Determine the opposite order type to close the position
    # If the current position is BUY, we need to SELL to close it.
    # If the current position is SELL, we need to BUY to close it.
    order_type = mt5.ORDER_TYPE_SELL if position_info.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY

    # Get current bid/ask for closing price
    tick = get_current_tick(position_info.symbol)
    if tick is None:
        print(f"Could not get current tick for {position_info.symbol} to close position.")
        return None
    # Use bid for closing a buy, ask for closing a sell
    price = tick.bid if position_info.type == mt5.ORDER_TYPE_BUY else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": position_info.symbol,
        "volume": position_info.volume,
        "type": order_type,
        "position": position_info.ticket, # CRUCIAL: Link this order to the specific position you want to close
        "price": price,
        "deviation": 20,
        "magic": MAGIC_NUMBER,
        "comment": "Python Close Position",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_RETURN, # Return any remaining volume if not completely filled
    }

    check_result = mt5.order_check(request)
    if check_result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Close order check failed: {check_result.comment}")
        return None

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Close order send failed: {result.comment} (Retcode: {result.retcode})")
        return None

    print(f"Position {position_ticket} closed successfully: {result.comment}")
    return result

# --- Simple Trading Strategy (Moving Average Crossover) ---

def run_trading_strategy():
    """
    Implements a simple Moving Average Crossover strategy.
    Buys when short MA crosses above long MA.
    Sells when short MA crosses below long MA.
    Closes existing position before opening a new one in the opposite direction.
    """
    print(f"\n--- Running Trading Strategy for {SYMBOL} at {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ---")

    # 1. Get historical data (the last 'BAR_COUNT' bars for the specified timeframe)
    df = get_historical_data(SYMBOL, TIMEFRAME, BAR_COUNT)
    if df.empty:
        print("No historical data available. Retrying in next cycle.")
        return # Exit the function if no data

    # 2. Calculate Moving Averages using Pandas' .rolling().mean()
    # Ensure enough data exists for the moving average periods
    if len(df) < max(SHORT_MA_PERIOD, LONG_MA_PERIOD):
        print(f"Not enough bars ({len(df)}) for MA calculation. Need at least {max(SHORT_MA_PERIOD, LONG_MA_PERIOD)}.")
        return

    df['SMA_Short'] = df['close'].rolling(window=SHORT_MA_PERIOD).mean()
    df['SMA_Long'] = df['close'].rolling(window=LONG_MA_PERIOD).mean()

    # Drop any rows that have NaN values (which occur at the beginning of the DataFrame
    # because there aren't enough preceding bars to calculate the full MA).
    df.dropna(inplace=True)

    if len(df) < 2: # Ensure we have at least two data points to check for a crossover
        print("Not enough data after dropping NaNs for crossover detection.")
        return

    # 3. Get the latest and previous MA values for crossover detection
    latest_short_ma = df['SMA_Short'].iloc[-1] # Most recent short MA
    prev_short_ma = df['SMA_Short'].iloc[-2]   # Previous short MA
    latest_long_ma = df['SMA_Long'].iloc[-1]   # Most recent long MA
    prev_long_ma = df['SMA_Long'].iloc[-2]     # Previous long MA
    latest_close_price = df['close'].iloc[-1]  # Most recent closing price

    print(f"Latest Close: {latest_close_price:.5f}")
    print(f"Latest Short MA ({SHORT_MA_PERIOD}): {latest_short_ma:.5f}")
    print(f"Latest Long MA ({LONG_MA_PERIOD}): {latest_long_ma:.5f}")

    # 4. Check current open positions for the specified symbol and our bot's magic number
    open_positions = get_open_positions(SYMBOL)
    # Check if we have any long or short positions opened by THIS bot
    has_long_position = any(p.type == mt5.ORDER_TYPE_BUY and p.magic == MAGIC_NUMBER for p in open_positions)
    has_short_position = any(p.type == mt5.ORDER_TYPE_SELL and p.magic == MAGIC_NUMBER for p in open_positions)
    current_position_ticket = None # To store the ticket of an existing position if found

    if has_long_position:
        current_position_ticket = next((p.ticket for p in open_positions if p.type == mt5.ORDER_TYPE_BUY and p.magic == MAGIC_NUMBER), None)
        print(f"Currently holding a LONG position (Ticket: {current_position_ticket}).")
    elif has_short_position:
        current_position_ticket = next((p.ticket for p in open_positions if p.type == mt5.ORDER_TYPE_SELL and p.magic == MAGIC_NUMBER), None)
        print(f"Currently holding a SHORT position (Ticket: {current_position_ticket}).")
    else:
        print("No open positions for this symbol from this bot.")

    # 5. Generate and execute trade signals based on MA crossover
    # BUY Signal: Short MA crosses above Long MA
    if prev_short_ma < prev_long_ma and latest_short_ma > latest_long_ma:
        print("--- BUY SIGNAL DETECTED (Short MA crossed above Long MA) ---")
        if has_short_position:
            print(f"Closing existing SHORT position (Ticket: {current_position_ticket}) before opening LONG.")
            close_position(current_position_ticket)
            time.sleep(1) # Give a brief moment for the close order to process
        if not has_long_position: # Only open a new buy trade if no long position is currently active
            print(f"Placing BUY order for {SYMBOL} at {LOT_SIZE} lots.")
            # Example: Add basic stop-loss and take-profit for a buy order
            # SL: price below current, TP: price above current
            # You'd calculate these dynamically based on risk management rules
            # send_order(SYMBOL, LOT_SIZE, mt5.ORDER_TYPE_BUY, sl=latest_close_price * 0.99, tp=latest_close_price * 1.01)
            send_order(SYMBOL, LOT_SIZE, mt5.ORDER_TYPE_BUY) # For now, no SL/TP
        else:
            print("Already in a LONG position. No new buy order needed.")

    # SELL Signal: Short MA crosses below Long MA
    elif prev_short_ma > prev_long_ma and latest_short_ma < latest_long_ma:
        print("--- SELL SIGNAL DETECTED (Short MA crossed below Long MA) ---")
        if has_long_position:
            print(f"Closing existing LONG position (Ticket: {current_position_ticket}) before opening SHORT.")
            close_position(current_position_ticket)
            time.sleep(1) # Give a brief moment for the close order to process
        if not has_short_position: # Only open a new sell trade if no short position is currently active
            print(f"Placing SELL order for {SYMBOL} at {LOT_SIZE} lots.")
            # Example: Add basic stop-loss and take-profit for a sell order
            # SL: price above current, TP: price below current
            # send_order(SYMBOL, LOT_SIZE, mt5.ORDER_TYPE_SELL, sl=latest_close_price * 1.01, tp=latest_close_price * 0.99)
            send_order(SYMBOL, LOT_SIZE, mt5.ORDER_TYPE_SELL) # For now, no SL/TP
        else:
            print("Already in a SHORT position. No new sell order needed.")
    else:
        print("No clear MA crossover signal. Holding position or waiting for next signal.")

# --- Main Loop ---

if __name__ == "__main__":
    # 1. Initialize MT5 connection
    if not initialize_mt5_connection():
        print("Failed to initialize MT5 connection. Exiting script.")
        exit() # Exit the script if connection fails

    # IMPORTANT: Remember to enable "Allow algorithmic trading" in your MT5 terminal:
    # Tools -> Options -> Expert Advisors -> "Allow algorithmic trading" checkbox.

    try:
        # 2. Continuous trading loop
        while True:
            run_trading_strategy() # Execute your trading logic
            print(f"Waiting for 60 seconds before next strategy check...")
            time.sleep(60) # Pause for 60 seconds (1 minute) before the next cycle
                           # Adjust this interval based on your timeframe (e.g., for H1, you might check every 5-10 minutes)
    except KeyboardInterrupt:
        # 3. Handle graceful shutdown if the user presses Ctrl+C
        print("\nTrading bot stopped by user (Ctrl+C).")
    except Exception as e:
        # 4. Catch any other unexpected errors
        print(f"An unexpected error occurred: {e}")
    finally:
        # 5. Ensure MT5 connection is shut down regardless of errors
        shutdown_mt5_connection()
        print("Script finished.")