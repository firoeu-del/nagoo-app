#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:-Nagoo-v1.37.1.apk}"
package_name="com.nagoo.partygame"
diagnostics_dir="android-runtime-diagnostics"

mkdir -p "$diagnostics_dir"
adb wait-for-device
adb logcat -c
adb install -r "$apk_path"
adb shell am force-stop "$package_name"
adb shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1

# Give fonts, bundled images and the initial entrance animation time to settle.
sleep 15

adb shell dumpsys activity activities > "$diagnostics_dir/activity.txt"
adb shell dumpsys window windows > "$diagnostics_dir/window.txt"
adb logcat -d -v threadtime > "$diagnostics_dir/logcat.txt"
adb exec-out screencap -p > "$diagnostics_dir/home.png"

for attempt in 1 2 3; do
  adb shell uiautomator dump /sdcard/nagoo-window.xml >/dev/null 2>&1 || true
  if adb pull /sdcard/nagoo-window.xml "$diagnostics_dir/window.xml" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

pid="$(adb shell pidof "$package_name" | tr -d '\r' || true)"
focused="$(grep -E "mCurrentFocus|mFocusedApp" "$diagnostics_dir/window.txt" | tail -n 4 || true)"
fatal="$(grep -E "FATAL EXCEPTION|AndroidRuntime.*Process: ${package_name}|ReactNativeJS.*(TypeError|ReferenceError|Error:)|JavascriptException|Unable to load script" "$diagnostics_dir/logcat.txt" || true)"
has_home_text=false
if test -f "$diagnostics_dir/window.xml" && grep -Eq "شروع بازی|قوانین|بگو" "$diagnostics_dir/window.xml"; then
  has_home_text=true
fi

cat > "$diagnostics_dir/result.json" <<JSON
{
  "package": "$package_name",
  "processAlive": $([ -n "$pid" ] && echo true || echo false),
  "pid": "$pid",
  "homeTextVisible": $has_home_text,
  "fatalLogDetected": $([ -n "$fatal" ] && echo true || echo false)
}
JSON

printf '%s\n' "$focused"
cat "$diagnostics_dir/result.json"

if [ -n "$fatal" ]; then
  printf '%s\n' "$fatal"
  echo "Android runtime test failed: fatal startup error detected."
  exit 1
fi
if [ -z "$pid" ]; then
  echo "Android runtime test failed: app process is not alive."
  exit 1
fi
if [ "$has_home_text" != true ]; then
  echo "Android runtime test failed: the home screen text is not visible."
  exit 1
fi

echo "Android runtime test passed."
