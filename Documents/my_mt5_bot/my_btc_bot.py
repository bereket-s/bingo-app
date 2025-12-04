import MetaTrader5 as mt5
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import time
import pytz
# ADDED: Imports for the 'ta' library
from ta.trend import EMAIndicator
from ta.volatility import AverageTrueRange

# --- MT5 Connection Details (Replace with your Exness MT5 details) ---
MT5_ACCOUNT = 210129682  # Your MT5 account login
MT5_PASSWORD = "199129@Bere."  # Your MT5 account password
MT5_SERVER = "Exness-MT5Trial9"  # Your Exness MT5 server (e.g., "Exness-MT5 Real", "Exness-MT5 Demo")
MT5_PATH = r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"  # Path to your MT5 terminal.exe (Windows)
                                                              # For Linux/Mac, you might need Wine or a different setup.
# --- Trading Parameters ---
SYMBOL = "BTCUSDm"  # Trading instrument (e.g., "XAUUSD", "EURUSD")
TIMEFRAME = mt5.TIMEFRAME_M15  # Timeframe for analysis (e.g., M1, M5, M15, H1, H4, D1)
MAX_TRADE_COUNT = 1  # Max number of open trades for this symbol

# --- Risk Management Parameters ---
RISK_PERCENT_PER_TRADE = 0.05
SL_MULTIPLIER = 1.5
TP_MULTIPLIER = 3.0

# --- Indicator Parameters ---
ATR_PERIOD = 14
EMA_SHORT_PERIOD = 20
EMA_LONG_PERIOD = 50
# PIVOT_POINT_PERIOD was removed as it's handled by manual calculation now
FIB_RET_LOOKBACK_BARS = 100
VOLUME_PROFILE_BUCKET_SIZE = 0.5
VOLUME_PROFILE_LOOKBACK_BARS = 200

# --- Bot Control ---
RUN_BOT = True

def connect_mt5():
    """Connects to the MetaTrader 5 terminal."""
    if not mt5.initialize(path=MT5_PATH, login=MT5_ACCOUNT, password=MT5_PASSWORD, server=MT5_SERVER):
        print(f"MT5 initialization failed, error code: {mt5.last_error()}")
        return False
    else:
        print("MT5 initialized successfully.")
        account_info = mt5.account_info()
        if account_info:
            print(f"Account: {account_info.login}, Server: {mt5.terminal_info().name}")
        else:
            print(f"Failed to get account info: {mt5.last_error()}")
        return True

def disconnect_mt5():
    """Disconnects from the MetaTrader 5 terminal."""
    mt5.shutdown()
    print("MT5 disconnected.")

def get_market_data(symbol, timeframe, bars_count):
    """Retrieves historical market data."""
    # Fetch enough data for all indicator lookbacks (ATR, EMAs, Fib, Volume Profile)
    # Ensure this is sufficiently large to cover all periods + buffer.
    # EMA_LONG_PERIOD + ATR_PERIOD + FIB_RET_LOOKBACK_BARS + VOLUME_PROFILE_LOOKBACK_BARS + buffer
    needed_bars = max(EMA_LONG_PERIOD, ATR_PERIOD, FIB_RET_LOOKBACK_BARS, VOLUME_PROFILE_LOOKBACK_BARS) + 50 # Add a buffer for safety
    
    timezone = pytz.timezone("Etc/UTC")
    # Get enough recent data to cover the needed bars, roughly 2 days per H4 bar, 1 day per D1, etc.
    # For M15, 30 days is usually plenty.
    utc_from = datetime.now(timezone) - timedelta(days=30) 
    
    rates = mt5.copy_rates_range(symbol, timeframe, utc_from, datetime.now(timezone))
    
    if rates is None:
        print(f"Failed to get rates for {symbol}, error code: {mt5.last_error()}")
        return pd.DataFrame()
    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    df = df.set_index('time') # Set time as index
    return df

def get_timeframe_name(timeframe_enum):
    """Converts MT5 timeframe enum to a readable string for printing."""
    if timeframe_enum == mt5.TIMEFRAME_M1: return "M1"
    elif timeframe_enum == mt5.TIMEFRAME_M5: return "M5"
    elif timeframe_enum == mt5.TIMEFRAME_M15: return "M15"
    elif timeframe_enum == mt5.TIMEFRAME_M30: return "M30"
    elif timeframe_enum == mt5.TIMEFRAME_H1: return "H1"
    elif timeframe_enum == mt5.TIMEFRAME_H4: return "H4"
    elif timeframe_enum == mt5.TIMEFRAME_D1: return "D1"
    elif timeframe_enum == mt5.TIMEFRAME_W1: return "W1"
    elif timeframe_enum == mt5.TIMEFRAME_MN1: return "MN1"
    else: return f"Unknown ({timeframe_enum})" # Fallback to integer if unknown

def calculate_indicators(df):
    """Calculates all required indicators using 'ta' library and manual calculations."""
    # Ensure 'open', 'high', 'low', 'close' are float types
    df['open'] = df['open'].astype(float)
    df['high'] = df['high'].astype(float)
    df['low'] = df['low'].astype(float)
    df['close'] = df['close'].astype(float)
    # Ensure volume is float for calculations if it's used in volume profile
    if 'real_volume' in df.columns:
        df['real_volume'] = df['real_volume'].astype(float)
    elif 'tick_volume' in df.columns: # Use tick_volume if real_volume is not available
        df['tick_volume'] = df['tick_volume'].astype(float)
    else:
        # Create a default 'tick_volume' column if neither exists, to prevent errors in VP
        df['tick_volume'] = 0.0 
        print("Warning: Neither 'real_volume' nor 'tick_volume' found. Volume profile may not be accurate.")


    # --- EMA (using 'ta' library) ---
    ema_short_indicator = EMAIndicator(close=df['close'], window=EMA_SHORT_PERIOD, fillna=False)
    df['EMA_Short'] = ema_short_indicator.ema_indicator()
    
    ema_long_indicator = EMAIndicator(close=df['close'], window=EMA_LONG_PERIOD, fillna=False)
    df['EMA_Long'] = ema_long_indicator.ema_indicator()

    # --- ATR (using 'ta' library) ---
    # Corrected usage: Instantiate AverageTrueRange
    atr_calculator = AverageTrueRange(high=df['high'], low=df['low'], close=df['close'], window=ATR_PERIOD, fillna=False)
    df['ATR'] = atr_calculator.average_true_range() # Method name is also correct here


    # --- Fibonacci Retracement Levels (Manual) ---
    # (No changes to this block)
    fib_df = df.iloc[-FIB_RET_LOOKBACK_BARS:].copy()
    fib_levels = {}
    if not fib_df.empty:
        swing_high = fib_df['high'].max()
        swing_low = fib_df['low'].min()
        
        if swing_high != swing_low:
            price_range = swing_high - swing_low
            fib_levels['0.0%'] = swing_high
            fib_levels['23.6%'] = swing_high - (0.236 * price_range)
            fib_levels['38.2%'] = swing_high - (0.382 * price_range)
            fib_levels['50.0%'] = swing_high - (0.500 * price_range)
            fib_levels['61.8%'] = swing_high - (0.618 * price_range)
            fib_levels['78.6%'] = swing_high - (0.786 * price_range)
            fib_levels['100.0%'] = swing_low
    df['fib_levels'] = [fib_levels] * len(df)


    # --- Pivot Points (Manual Calculation) ---
    pivot_points = {}
    
    # Resample to daily bars to get previous day's OHLC
    daily_ohlc = df[['open', 'high', 'low', 'close']].resample('D').agg({
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last'
    }).dropna()

    if len(daily_ohlc) >= 2: # Ensure we have at least the previous complete day's data
        prev_day = daily_ohlc.iloc[-2] # Get the OHLC of the previous complete day
        
        high = prev_day['high']
        low = prev_day['low']
        close = prev_day['close']
        
        pp = (high + low + close) / 3
        r1 = (2 * pp) - low
        s1 = (2 * pp) - high
        r2 = pp + (high - low)
        s2 = pp - (high - low)
        r3 = high + (2 * (pp - low))
        s3 = low - (2 * (high - pp))

        pivot_points['PP'] = pp
        pivot_points['R1'] = r1
        pivot_points['R2'] = r2
        pivot_points['R3'] = r3
        pivot_points['S1'] = s1
        pivot_points['S2'] = s2
        pivot_points['S3'] = s3
    else:
        # print("Warning: Not enough daily data for pivot point calculation. Pivot points set to NaN.")
        pivot_points = {k: np.nan for k in ['PP', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3']}

    df['pivot_points'] = [pivot_points] * len(df)


    # --- High Volume Nodes (HVN) / Low Volume Nodes (LVN) (Volume Profile - Basic) ---
    volume_profile = {}
    vp_df = df.iloc[-VOLUME_PROFILE_LOOKBACK_BARS:].copy()
    if not vp_df.empty:
        min_price = vp_df['low'].min()
        max_price = vp_df['high'].max()
        
        if (max_price - min_price) <= 0: # Handle cases where price range is zero (e.g., flat data)
            df['hvns'] = [[]] * len(df)
            df['lvns'] = [[]] * len(df)
            return df # Exit early if no price range

        num_buckets = int((max_price - min_price) / VOLUME_PROFILE_BUCKET_SIZE) + 1
        price_bins = np.linspace(min_price, max_price, num_buckets)
        
        # Determine which volume column to use
        volume_col = 'real_volume' if 'real_volume' in vp_df.columns else 'tick_volume'

        for i in range(len(vp_df)):
            bar_high = vp_df['high'].iloc[i]
            bar_low = vp_df['low'].iloc[i]
            bar_volume = vp_df[volume_col].iloc[i] # Use the determined volume column
            
            for j in range(len(price_bins) - 1):
                bucket_low = price_bins[j]
                bucket_high = price_bins[j+1]
                
                if max(bucket_low, bar_low) < min(bucket_high, bar_high):
                    overlap_range = min(bucket_high, bar_high) - max(bucket_low, bar_low)
                    bar_range = bar_high - bar_low
                    if bar_range > 0:
                        volume_in_bucket = bar_volume * (overlap_range / bar_range)
                        avg_price_in_bucket = (bucket_low + bucket_high) / 2
                        volume_profile[avg_price_in_bucket] = volume_profile.get(avg_price_in_bucket, 0) + volume_in_bucket
                    else: # Handle zero-range bars (e.g., dojis) by assigning volume to the bucket containing the close
                        avg_price_in_bucket = (bucket_low + bucket_high) / 2
                        if bucket_low <= bar_high <= bucket_high:
                            volume_profile[avg_price_in_bucket] = volume_profile.get(avg_price_in_bucket, 0) + bar_volume
            
        if volume_profile: # Check if volume_profile dict is populated
            sorted_vp = sorted(volume_profile.items(), key=lambda item: item[1], reverse=True)
            
            hvn_threshold = sorted_vp[int(len(sorted_vp) * 0.1)][1] if len(sorted_vp) > 0 else 0
            lvn_threshold = sorted_vp[int(len(sorted_vp) * 0.9)][1] if len(sorted_vp) > 0 else 0

            hvns = [price for price, vol in volume_profile.items() if vol >= hvn_threshold]
            lvns = [price for price, vol in volume_profile.items() if vol <= lvn_threshold]
            
            df['hvns'] = [hvns] * len(df)
            df['lvns'] = [lvns] * len(df)
        else: # If volume_profile is empty, set empty lists
            df['hvns'] = [[]] * len(df)
            df['lvns'] = [[]] * len(df)
    else: # If vp_df is empty, set empty lists
        df['hvns'] = [[]] * len(df)
        df['lvns'] = [[]] * len(df)

    return df

def get_current_price(symbol):
    """Gets the current bid and ask prices."""
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        print(f"Failed to get tick for {symbol}, error code: {mt5.last_error()}")
        return None, None
    return tick.bid, tick.ask

def calculate_lot_size(symbol, risk_percent, sl_points):
    """
    Calculates the appropriate lot size based on risk percentage and stop loss distance.
    """
    account_info = mt5.account_info()
    if account_info is None:
        print("Failed to get account info for lot size calculation.")
        return 0.0

    equity = account_info.equity
    if equity <= 0:
        print("Account equity is zero or negative. Cannot calculate lot size.")
        return 0.0

    risk_amount = equity * risk_percent
    
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        print(f"Failed to get symbol info for {symbol}.")
        return 0.0

    # For XAUUSD, value of 1 point (0.01) for 1 lot (100 units) is $1.
    # Check symbol_info.trade_tick_value or symbol_info.trade_contract_size if unsure
    # For XAUUSD often 1 contract size is 100 units, and tick size is 0.01, so 1 point (0.01) = $1 for 1 standard lot (100 units).
    # If your broker's XAUUSD has a different contract size or tick value, adjust this.
    cost_per_point_per_lot = 1.0 # This is typically $1 for XAUUSD per 0.01 point for a 1 standard lot
                                 
    if sl_points == 0:
        print("Stop Loss in points is zero. Cannot calculate lot size.")
        return 0.0

    calculated_volume = risk_amount / (sl_points * cost_per_point_per_lot)

    volume_step = symbol_info.volume_step
    volume_min = symbol_info.volume_min
    volume_max = symbol_info.volume_max

    # Quantize the volume to the nearest step and ensure it's within min/max
    calculated_volume = np.floor(calculated_volume / volume_step) * volume_step
    calculated_volume = max(volume_min, min(calculated_volume, volume_max))

    return calculated_volume

def send_order(symbol, trade_type, volume, price, sl, tp, comment=""):
    """Sends a trade order."""
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5.ORDER_TYPE_BUY if trade_type == "BUY" else mt5.ORDER_TYPE_SELL,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": 20, # Max allowed deviation from the requested price
        "magic": 20230623, # Unique identifier for your bot's orders
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_FOK, # Fill or Kill
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        print(f"Order failed: {result.retcode}, comment: {result.comment}")
        return None
    else:
        print(f"Order successful: {trade_type} {volume:.2f} {symbol} at {price:.5f}. Ticket: {result.order}")
        return result.order

def manage_trades():
    """Checks for open positions and manages them (e.g., trailing stop, partial close)."""
    positions = mt5.positions_get(symbol=SYMBOL)
    if positions:
        print(f"\n--- Open Positions for {SYMBOL} ---")
        for position in positions:
            print(f"  Ticket: {position.ticket}, Type: {'BUY' if position.type == mt5.ORDER_TYPE_BUY else 'SELL'}, Volume: {position.volume:.2f}, "
                  f"Price: {position.price_open:.5f}, Current Price: {position.price_current:.5f}, "
                  f"Profit: {position.profit:.2f}")
        print("----------------------------\n")
    # else:
    # print(f"No open positions for {SYMBOL}.") # Keep silent if no positions

def get_open_trades_count(symbol):
    """Returns the number of open trades for a given symbol."""
    positions = mt5.positions_get(symbol=symbol)
    if positions:
        return len(positions)
    return 0

def main():
    if not connect_mt5():
        return

    try:
        symbol_info = mt5.symbol_info(SYMBOL)
        if symbol_info is None:
            print(f"Could not get symbol info for {SYMBOL}. Exiting.")
            disconnect_mt5()
            return
        
        # Smallest point value for this symbol (e.g., 0.00001 for EURUSD, 0.01 for XAUUSD)
        point = symbol_info.point 

        while RUN_BOT:
            # Adjust bars_count based on your longest lookback period
            # Ensure enough data for all indicators (even if some data is dropped by fillna=False)
            data = get_market_data(SYMBOL, TIMEFRAME, VOLUME_PROFILE_LOOKBACK_BARS + FIB_RET_LOOKBACK_BARS + EMA_LONG_PERIOD + ATR_PERIOD + 50)
            
            # Check if enough data is available AFTER potential NaNs from indicator calculations
            required_valid_bars = max(EMA_LONG_PERIOD, ATR_PERIOD) # Min bars for the 'ta' lib to return valid values
            if data.empty or len(data.dropna(subset=['close'])) < required_valid_bars + 1: # Check for actual valid rows after potential NaNs
                print("Not enough market data for indicator calculation (or too many NaNs). Waiting...")
                time.sleep(60)
                continue

            data = calculate_indicators(data)
            
            # Ensure indicators are calculated (no NaNs at the end)
            # The 'ta' library handles initial NaNs by returning NaN for the first `window` periods.
            # So ensure you have enough data for the last few values to be valid.
            # Also check if dictionaries are empty for the last row
            last_row_data = data.iloc[-1]
            if last_row_data['EMA_Short'] is np.nan or last_row_data['ATR'] is np.nan or \
               not last_row_data['pivot_points'] or not last_row_data['fib_levels']:
                print("Indicators not fully calculated yet (NaNs or empty dictionaries for latest bar). Waiting for more data...")
                time.sleep(60)
                continue

            current_bid, current_ask = get_current_price(SYMBOL)
            if current_bid is None or current_ask is None:
                time.sleep(5)
                continue

            last_close = data['close'].iloc[-1]
            current_ema_short = data['EMA_Short'].iloc[-1]
            current_ema_long = data['EMA_Long'].iloc[-1]
            current_atr = data['ATR'].iloc[-1]
            current_fib_levels = data['fib_levels'].iloc[-1]
            current_pivot_points = data['pivot_points'].iloc[-1]
            current_hvns = data['hvns'].iloc[-1]
            current_lvns = data['lvns'].iloc[-1]

            print(f"\n--- Market Data & Indicators for {SYMBOL} ({get_timeframe_name(TIMEFRAME)}) ---")
            print(f"Current Price: Bid={current_bid:.5f}, Ask={current_ask:.5f}")
            print(f"EMAs: Short={current_ema_short:.5f}, Long={current_ema_long:.5f}")
            print(f"ATR ({ATR_PERIOD}): {current_atr:.5f}")
            print(f"Fibonacci Levels: { {k: f'{v:.5f}' for k, v in current_fib_levels.items()} if current_fib_levels else 'N/A' }")
            print(f"Pivot Points: { {k: f'{v:.5f}' for k, v in current_pivot_points.items()} if current_pivot_points and not np.isnan(current_pivot_points.get('PP', np.nan)) else 'N/A' }")
            print(f"High Volume Nodes (HVNs): { [f'{p:.5f}' for p in current_hvns] }")
            print(f"Low Volume Nodes (LVNs): { [f'{p:.5f}' for p in current_lvns] }")
            
            account_info_latest = mt5.account_info()
            if account_info_latest:
                print(f"Account Equity: {account_info_latest.equity:.2f}")
            else:
                print("Could not retrieve latest account equity.")


            open_trades = get_open_trades_count(SYMBOL)

            if open_trades < MAX_TRADE_COUNT:
                # --- Define your combined SNR and Entry Logic here ---
                
                potential_supports = []
                potential_resistances = []

                # Add Fib Levels
                for level_name, level_price in current_fib_levels.items():
                    if pd.isna(level_price): continue # Skip NaN levels
                    if level_name in ['0.0%', '23.6%', '38.2%', '50.0%', '61.8%', '78.6%', '100.0%']: # Specific fib levels
                        # For fibs, interpret based on their typical role or just proximity
                        if level_price < current_bid: potential_supports.append(level_price)
                        else: potential_resistances.append(level_price)

                # Add Pivot Points
                # Ensure pivot points are not NaN before adding
                if current_pivot_points:
                    for k, v in current_pivot_points.items():
                        if pd.isna(v): continue
                        if k == 'PP':
                            if v < current_bid: potential_supports.append(v)
                            else: potential_resistances.append(v)
                        elif k.startswith('S'):
                            potential_supports.append(v)
                        elif k.startswith('R'):
                            potential_resistances.append(v)
                
                # Add EMAs as dynamic S/R
                if not pd.isna(current_ema_short):
                    if current_ema_short < current_bid: potential_supports.append(current_ema_short)
                    else: potential_resistances.append(current_ema_short)
                if not pd.isna(current_ema_long):
                    if current_ema_long < current_bid: potential_supports.append(current_ema_long)
                    else: potential_resistances.append(current_ema_long)

                # Add HVNs as strong S/R
                for hvn in current_hvns:
                    if not pd.isna(hvn):
                        if hvn < current_bid: potential_supports.append(hvn)
                        else: potential_resistances.append(hvn)

                # Filter and get closest relevant levels
                # Make sure to handle cases where potential_supports/resistances are empty
                closest_support = max([s for s in potential_supports if s < current_bid] + [-np.inf]) if potential_supports else -np.inf
                closest_resistance = min([r for r in potential_resistances if r > current_ask] + [np.inf]) if potential_resistances else np.inf
                
                confluence_tolerance = current_atr * 0.25 # ATR based tolerance for proximity

                # --- BUY ENTRY LOGIC ---
                # Check for enough data for previous EMA values
                if len(data) >= 2:
                    prev_ema_short = data['EMA_Short'].iloc[-2]
                    prev_ema_long = data['EMA_Long'].iloc[-2]
                    prev_close = data['close'].iloc[-2]
                else: # Not enough data for comparison
                    prev_ema_short = current_ema_short
                    prev_ema_long = current_ema_long
                    prev_close = last_close # Fallback

                ema_crossover_buy = (prev_ema_short < prev_ema_long) and \
                                     (current_ema_short > current_ema_long)
                
                is_near_support_confluence = False
                buy_confluence_levels = [closest_support] + current_hvns + \
                                      [current_pivot_points.get('S1', np.nan), # Use .get for robustness
                                       current_fib_levels.get('61.8%', np.nan),
                                       current_fib_levels.get('50.0%', np.nan)]
                
                for level in buy_confluence_levels:
                    if not pd.isna(level) and abs(current_bid - level) < confluence_tolerance:
                        is_near_support_confluence = True
                        break

                has_bounced_from_support = (is_near_support_confluence and last_close > prev_close)

                if (ema_crossover_buy and has_bounced_from_support) or \
                   (abs(current_bid - closest_support) < confluence_tolerance and has_bounced_from_support):
                    
                    sl_price = round(current_ask - (current_atr * SL_MULTIPLIER), symbol_info.digits)
                    tp_price = round(current_ask + (current_atr * TP_MULTIPLIER), symbol_info.digits)

                    # Ensure SL is not above entry for buy, add a small buffer if too close
                    if sl_price >= current_ask: sl_price = current_ask - (symbol_info.point * 10) # 10 points below
                    
                    stop_loss_points = abs(current_ask - sl_price) / point
                    calculated_volume = calculate_lot_size(SYMBOL, RISK_PERCENT_PER_TRADE, stop_loss_points)

                    if calculated_volume > 0:
                        print(f"--- BUY SIGNAL ---")
                        print(f"  Reason: EMA bullish crossover and near support confluence.")
                        print(f"  Calculated Volume: {calculated_volume:.2f}, SL: {sl_price:.5f}, TP: {tp_price:.5f}")
                        send_order(SYMBOL, "BUY", calculated_volume, current_ask, sl_price, tp_price, "Multi-Indicator Buy")
                        time.sleep(10)
                    else:
                         print(f"Calculated BUY volume is zero or too small: {calculated_volume:.5f}. Skipping trade.")


                # --- SELL ENTRY LOGIC ---
                ema_crossover_sell = (prev_ema_short > prev_ema_long) and \
                                      (current_ema_short < current_ema_long)
                
                is_near_resistance_confluence = False
                sell_confluence_levels = [closest_resistance] + current_hvns + \
                                       [current_pivot_points.get('R1', np.nan), 
                                        current_fib_levels.get('38.2%', np.nan),
                                        current_fib_levels.get('50.0%', np.nan)]
                
                for level in sell_confluence_levels:
                    if not pd.isna(level) and abs(current_bid - level) < confluence_tolerance:
                        is_near_resistance_confluence = True
                        break

                has_bounced_from_resistance = (is_near_resistance_confluence and last_close < prev_close)

                if (ema_crossover_sell and has_bounced_from_resistance) or \
                   (abs(current_bid - closest_resistance) < confluence_tolerance and has_bounced_from_resistance):
                    
                    sl_price = round(current_bid + (current_atr * SL_MULTIPLIER), symbol_info.digits)
                    tp_price = round(current_bid - (current_atr * TP_MULTIPLIER), symbol_info.digits)

                    # Ensure SL is not below entry for sell, add a small buffer if too close
                    if sl_price <= current_bid: sl_price = current_bid + (symbol_info.point * 10) # 10 points above

                    stop_loss_points = abs(current_bid - sl_price) / point
                    calculated_volume = calculate_lot_size(SYMBOL, RISK_PERCENT_PER_TRADE, stop_loss_points)

                    if calculated_volume > 0:
                        print(f"--- SELL SIGNAL ---")
                        print(f"  Reason: EMA bearish crossover and near resistance confluence.")
                        print(f"  Calculated Volume: {calculated_volume:.2f}, SL: {sl_price:.5f}, TP: {tp_price:.5f}")
                        send_order(SYMBOL, "SELL", calculated_volume, current_bid, sl_price, tp_price, "Multi-Indicator Sell")
                        time.sleep(10)
                    else:
                        print(f"Calculated SELL volume is zero or too small: {calculated_volume:.5f}. Skipping trade.")
            else:
                print(f"Maximum allowed trades ({MAX_TRADE_COUNT}) already open for {SYMBOL}. No new trades.")

            manage_trades()

            time.sleep(60) # Wait 60 seconds before next loop iteration

    except KeyboardInterrupt:
        print("Bot stopped by user.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        # Optional: Log the full traceback for debugging
        # import traceback
        # traceback.print_exc()
    finally:
        disconnect_mt5()

if __name__ == "__main__":
    main()