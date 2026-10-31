package vw.app.bridge;

import android.os.Bundle;
import com.android.uiautomator.testrunner.UiAutomatorTestRunner;

import java.io.IOException;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Private, observation-only diagnostic prototype. Original implementation.
 * No input, accessibility actions, screenshots, app settings or secure-window
 * flags are changed. All Android API calls except the runner entry signature
 * use reflection, so a host android.jar is not required for compilation.
 */
public final class ExtendedUiDumpRunner extends UiAutomatorTestRunner {
    private static final String EXPECTED_PACKAGE = "com.volkswagen.weconnect";
    private static final String WRAPPER_CLASS = "com.android.uiautomator.core.UiAutomationShellWrapper";
    private static final int MAX_NODES = 2000;
    private static final int MAX_DEPTH = 40;
    private static final int MAX_STRING = 5000;
    private static final int MAX_OUTPUT = 2 * 1024 * 1024;
    private static final int MAX_EXTRAS = 64;
    private static final int MAX_ACTIONS = 64;
    private static final int MAX_ARRAY = 64;
    private static final int MAX_WINDOWS = 16;
    private static final long READ_BUDGET_NANOS = 12000000000L;
    private Object parameters;
    private boolean unsupportedOptions;

    /** The real Android-12 CLI entry point; start() itself takes no arguments. */
    @Override
    public void run(List<String> testClasses, Bundle params, boolean debug, boolean monkey) {
        parameters = params;
        unsupportedOptions = debug || monkey;
        start();
    }

    @Override
    protected void start() {
        boolean success = false;
        String code = "INTERNAL";
        try {
            if (unsupportedOptions) throw new Failure("UNSUPPORTED_OPTIONS");
            String out = outputParameter(parameters);
            Path destination = outputPath(out);
            String json = captureJSON();
            writeNewPrivateFile(destination, json);
            success = true;
        } catch (Failure error) {
            code = error.code;
        } catch (Throwable error) {
            // Never print an exception, app value, path or raw platform output.
            code = "INTERNAL";
        }
        System.out.println(success ? "VW_UI_DUMP_OK" : "VW_UI_DUMP_ERROR:" + code);
        System.out.flush();
        System.exit(success ? 0 : 2);
    }

    /** Fresh one-shot read session; callers must not keep another session open. */
    public static String captureJSON() throws Exception {
        return new Observation().capture();
    }

    private static String outputParameter(Object params) throws Failure {
        if (params == null) throw new Failure("INVALID_OUTPUT");
        try {
            Object out = params.getClass().getMethod("getString", String.class).invoke(params, "out");
            if (!(out instanceof String)) throw new Failure("INVALID_OUTPUT");
            return (String) out;
        } catch (Failure error) {
            throw error;
        } catch (Throwable error) {
            throw new Failure("INVALID_OUTPUT");
        }
    }

    private static Path outputPath(String out) throws Failure {
        if (out == null || out.contains("..")
                || !out.matches("/data/local/tmp/vw-app-[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.json")) {
            throw new Failure("INVALID_OUTPUT");
        }
        Path path = Paths.get(out);
        if (!path.isAbsolute() || !path.normalize().equals(path)
                || !Paths.get("/data/local/tmp").equals(path.getParent())) {
            throw new Failure("INVALID_OUTPUT");
        }
        return path;
    }

    private static void writeNewPrivateFile(Path destination, String json) throws Failure {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_OUTPUT) throw new Failure("LIMIT_EXCEEDED");
        boolean created = false;
        boolean complete = false;
        Set<OpenOption> options = new HashSet<OpenOption>();
        options.add(StandardOpenOption.CREATE_NEW);
        options.add(StandardOpenOption.WRITE);
        options.add(LinkOption.NOFOLLOW_LINKS);
        try {
            try (SeekableByteChannel channel = Files.newByteChannel(destination, options,
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
                created = true;
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) channel.write(buffer);
            }
            complete = true;
        } catch (Throwable error) {
            throw new Failure("OUTPUT_IO");
        } finally {
            if (created && !complete) {
                try { Files.deleteIfExists(destination); } catch (IOException ignored) { }
            }
        }
    }

    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }

    private static final class Observation {
        private final Map<String, Method> methods = new HashMap<String, Method>();
        private final Set<String> unsupported = new TreeSet<String>();
        private final long deadline = System.nanoTime() + READ_BUDGET_NANOS;
        private int nodes;
        private Object automation;

        String capture() throws Failure {
            Object wrapper = null;
            Object serviceInfo = null;
            int previousFlags = 0;
            boolean connected = false;
            Object root = null;
            Object after = null;
            boolean cleanupFailed = false;
            String result = null;
            try {
                wrapper = Class.forName(WRAPPER_CLASS).getConstructor().newInstance();
                required(wrapper, "connect");
                connected = true;
                automation = required(wrapper, "getUiAutomation");
                if (automation == null) throw new Failure("AUTOMATION_UNAVAILABLE");
                serviceInfo = required(automation, "getServiceInfo");
                if (serviceInfo == null) throw new Failure("AUTOMATION_UNAVAILABLE");
                Field flags = serviceInfo.getClass().getField("flags");
                previousFlags = flags.getInt(serviceInfo);
                Class<?> infoClass = Class.forName("android.accessibilityservice.AccessibilityServiceInfo");
                int include = infoClass.getField("FLAG_INCLUDE_NOT_IMPORTANT_VIEWS").getInt(null);
                int windows = infoClass.getField("FLAG_RETRIEVE_INTERACTIVE_WINDOWS").getInt(null);
                flags.setInt(serviceInfo, previousFlags | include | windows);
                required(automation, "setServiceInfo", new Class<?>[] { infoClass }, new Object[] { serviceInfo });
                try {
                    invoke(automation, "waitForIdle", new Class<?>[] { long.class, long.class },
                            new Object[] { Long.valueOf(100), Long.valueOf(1500) });
                } catch (InvocationTargetException error) {
                    if (!(error.getCause() instanceof java.util.concurrent.TimeoutException)) throw error;
                    // An animated UI may never be idle; package/focus checks below still apply.
                }

                WindowSnapshot beforeWindows = windows();
                root = required(automation, "getRootInActiveWindow");
                checkRoot(root);
                rejectSensitive(root, 0, new int[]{0});
                int beforeId = number(required(root, "getWindowId"));
                String beforeClass = string(required(root, "getClassName"));
                long startedAt = System.currentTimeMillis();
                Json json = new Json();
                json.append("{");
                json.field("format", "vw-app-extended-accessibility-v1", true);
                json.field("package", EXPECTED_PACKAGE, false);
                json.field("readOnly", Boolean.TRUE, false);
                json.field("startedAtEpochMs", Long.valueOf(startedAt), false);
                json.field("windowId", Integer.valueOf(beforeId), false);
                json.field("windowsBefore", beforeWindows.values, false);
                json.append(",\"root\":");
                node(root, 0, json);

                after = required(automation, "getRootInActiveWindow");
                checkRoot(after);
                rejectSensitive(after, 0, new int[]{0});
                if (number(required(after, "getWindowId")) != beforeId
                        || !equal(beforeClass, string(required(after, "getClassName")))) {
                    throw new Failure("ACTIVE_WINDOW_CHANGED");
                }
                WindowSnapshot afterWindows = windows();
                if (!beforeWindows.focusSignature.equals(afterWindows.focusSignature)) {
                    throw new Failure("ACTIVE_WINDOW_CHANGED");
                }
                json.field("windowsAfter", afterWindows.values, false);
                json.field("nodeCount", Integer.valueOf(nodes), false);
                json.field("unsupportedGetters", new ArrayList<String>(unsupported), false);
                json.field("finishedAtEpochMs", Long.valueOf(System.currentTimeMillis()), false);
                json.append("}\n");
                result = json.toString();
            } catch (Failure error) {
                throw error;
            } catch (Throwable error) {
                throw new Failure("PLATFORM_API");
            } finally {
                recycle(root);
                if (after != root) recycle(after);
                if (automation != null && serviceInfo != null) {
                    try {
                        serviceInfo.getClass().getField("flags").setInt(serviceInfo, previousFlags);
                        // Cleanup must remain effective after the read budget expires.
                        automation.getClass().getMethod("setServiceInfo", serviceInfo.getClass())
                                .invoke(automation, serviceInfo);
                    } catch (Throwable ignored) { cleanupFailed = true; }
                }
                if (wrapper != null) {
                    try { wrapper.getClass().getMethod("disconnect").invoke(wrapper); }
                    catch (Throwable ignored) { if (connected) cleanupFailed = true; }
                }
            }
            if (cleanupFailed) throw new Failure("SESSION_CLEANUP");
            return result;
        }

        private void rejectSensitive(Object node, int depth, int[] visited) throws Failure {
            if (depth > MAX_DEPTH || ++visited[0] > MAX_NODES) throw new Failure("LIMIT_EXCEEDED");
            checkRoot(node);
            String text = string(required(node, "getText"));
            String description = string(required(node, "getContentDescription"));
            if (Boolean.TRUE.equals(required(node, "isPassword")) || text != null && text.contains("S-PIN eingeben")
                    || description != null && description.contains("S-PIN eingeben")) throw new Failure("SENSITIVE_UI");
            int count = number(required(node, "getChildCount"));
            if (count < 0 || count > MAX_NODES) throw new Failure("LIMIT_EXCEEDED");
            for (int index=0; index<count; index++) {
                Object child = required(node, "getChild", new Class<?>[]{int.class}, new Object[]{Integer.valueOf(index)});
                try { rejectSensitive(child, depth+1, visited); } finally { recycle(child); }
            }
        }
        private void checkRoot(Object root) throws Failure {
            if (root == null) throw new Failure("ROOT_UNAVAILABLE");
            if (!EXPECTED_PACKAGE.equals(string(required(root, "getPackageName")))) {
                throw new Failure("ACTIVE_WINDOW_NOT_VW");
            }
        }

        private WindowSnapshot windows() throws Failure {
            Object value = required(automation, "getWindows");
            if (!(value instanceof List<?>)) throw new Failure("WINDOWS_UNAVAILABLE");
            List<?> list = (List<?>) value;
            if (list.size() > MAX_WINDOWS) throw new Failure("LIMIT_EXCEEDED");
            List<Map<String, Object>> selected = new ArrayList<Map<String, Object>>();
            List<String> focus = new ArrayList<String>();
            int foreign = 0;
            int applications = 0;
            int active = 0;
            int focused = 0;
            for (Object window : list) {
                Object windowRoot = null;
                try {
                    boolean isActive = bool(required(window, "isActive"));
                    boolean isFocused = bool(required(window, "isFocused"));
                    int id = number(required(window, "getId"));
                    int type = number(required(window, "getType"));
                    windowRoot = required(window, "getRoot");
                    String pkg = windowRoot == null ? null : string(required(windowRoot, "getPackageName"));
                    if (!EXPECTED_PACKAGE.equals(pkg)) {
                        if (isActive || isFocused) throw new Failure("ACTIVE_WINDOW_NOT_VW");
                        foreign++;
                        continue; // No other app's text, title, package or tree is serialized.
                    }
                    if (type == 1) applications++;
                    if (isActive) active++;
                    if (isFocused) focused++;
                    if (isActive || isFocused) focus.add(id + ":" + type + ":" + isActive + ":" + isFocused);
                    Map<String, Object> info = map();
                    info.put("id", Integer.valueOf(id));
                    info.put("type", Integer.valueOf(type));
                    info.put("active", Boolean.valueOf(isActive));
                    info.put("focused", Boolean.valueOf(isFocused));
                    info.put("accessibilityFocused", optional(window, "isAccessibilityFocused"));
                    info.put("layer", optional(window, "getLayer"));
                    info.put("title", text(window, "getTitle"));
                    info.put("bounds", bounds(window));
                    selected.add(info);
                } finally {
                    recycle(windowRoot);
                    recycle(window);
                }
            }
            if (active > 1 || focused > 1) throw new Failure("AMBIGUOUS_ACTIVE_WINDOW");
            if (active == 0 || focused == 0) throw new Failure("VW_FOCUS_UNCONFIRMED");
            Collections.sort(focus);
            Map<String, Object> result = map();
            result.put("vwWindows", selected);
            result.put("multipleVwApplicationWindows", Boolean.valueOf(applications > 1));
            result.put("foreignWindowCount", Integer.valueOf(foreign));
            return new WindowSnapshot(result, focus.toString());
        }

        private void node(Object value, int depth, Json json) throws Failure {
            checkBudget();
            if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Failure("LIMIT_EXCEEDED");
            checkRoot(value); // Verify every child before reading any textual app data.
            String securityText = string(required(value, "getText")), securityDescription = string(required(value, "getContentDescription"));
            if (Boolean.TRUE.equals(required(value, "isPassword")) || securityText != null && securityText.contains("S-PIN eingeben")
                    || securityDescription != null && securityDescription.contains("S-PIN eingeben")) throw new Failure("SENSITIVE_UI");
            Map<String, Object> fields = map();
            fields.put("package", EXPECTED_PACKAGE);
            fields.put("id", text(value, "getViewIdResourceName"));
            fields.put("class", text(value, "getClassName"));
            fields.put("text", text(value, "getText"));
            fields.put("description", text(value, "getContentDescription"));
            fields.put("stateDescription", text(value, "getStateDescription"));
            fields.put("hintText", text(value, "getHintText"));
            fields.put("paneTitle", text(value, "getPaneTitle"));
            fields.put("errorText", text(value, "getError"));
            fields.put("bounds", bounds(value));
            String[][] booleans = {
                { "visible", "isVisibleToUser" }, { "enabled", "isEnabled" },
                { "clickable", "isClickable" }, { "longClickable", "isLongClickable" },
                { "checkable", "isCheckable" }, { "checked", "isChecked" },
                { "selected", "isSelected" }, { "scrollable", "isScrollable" },
                { "focusable", "isFocusable" }, { "focused", "isFocused" },
                { "accessibilityFocused", "isAccessibilityFocused" },
                { "password", "isPassword" }, { "heading", "isHeading" },
                { "screenReaderFocusable", "isScreenReaderFocusable" },
                { "importantForAccessibility", "isImportantForAccessibility" }
            };
            for (String[] property : booleans) fields.put(property[0], optional(value, property[1]));
            fields.put("rangeInfo", range(optional(value, "getRangeInfo")));
            fields.put("collectionInfo", collection(optional(value, "getCollectionInfo"), false));
            fields.put("collectionItemInfo", collection(optional(value, "getCollectionItemInfo"), true));
            Map<String, Object> selection = map();
            selection.put("start", optional(value, "getTextSelectionStart"));
            selection.put("end", optional(value, "getTextSelectionEnd"));
            fields.put("textSelection", selection);
            fields.put("actions", actions(optional(value, "getActionList")));
            fields.put("extras", extras(optional(value, "getExtras")));
            fields.put("availableExtraData", strings(optional(value, "getAvailableExtraData"), MAX_EXTRAS));
            json.append("{");
            boolean first = true;
            for (Map.Entry<String, Object> field : fields.entrySet()) {
                json.field(field.getKey(), field.getValue(), first);
                first = false;
            }
            json.append(",\"children\":[");
            int children = number(required(value, "getChildCount"));
            if (children < 0 || children > MAX_NODES) throw new Failure("LIMIT_EXCEEDED");
            for (int index = 0; index < children; index++) {
                checkBudget();
                Object child = required(value, "getChild", new Class<?>[] { int.class }, new Object[] { Integer.valueOf(index) });
                if (child == null) throw new Failure("NODE_UNAVAILABLE");
                try {
                    if (index != 0) json.append(",");
                    node(child, depth + 1, json);
                } finally { recycle(child); }
            }
            json.append("]}");
        }

        private Object range(Object value) throws Failure {
            if (value == null) return null;
            Map<String, Object> result = map();
            result.put("type", optional(value, "getType"));
            result.put("min", optional(value, "getMin"));
            result.put("max", optional(value, "getMax"));
            result.put("current", optional(value, "getCurrent"));
            return result;
        }

        private Object collection(Object value, boolean item) throws Failure {
            if (value == null) return null;
            Map<String, Object> result = map();
            String[][] fields = item ? new String[][] {
                { "rowIndex", "getRowIndex" }, { "rowSpan", "getRowSpan" },
                { "columnIndex", "getColumnIndex" }, { "columnSpan", "getColumnSpan" },
                { "heading", "isHeading" }, { "selected", "isSelected" }
            } : new String[][] {
                { "rowCount", "getRowCount" }, { "columnCount", "getColumnCount" },
                { "hierarchical", "isHierarchical" }, { "selectionMode", "getSelectionMode" }
            };
            for (String[] field : fields) result.put(field[0], optional(value, field[1]));
            return result;
        }

        private Object actions(Object value) throws Failure {
            if (value == null) return null;
            if (!(value instanceof List<?>)) throw new Failure("PLATFORM_RESULT");
            List<?> list = (List<?>) value;
            if (list.size() > MAX_ACTIONS) throw new Failure("LIMIT_EXCEEDED");
            List<Object> result = new ArrayList<Object>();
            for (Object action : list) {
                Map<String, Object> entry = map();
                entry.put("id", required(action, "getId"));
                entry.put("label", text(action, "getLabel"));
                result.add(entry);
            }
            return result;
        }

        private Object extras(Object value) throws Failure {
            if (value == null) return null;
            Object keys = required(value, "keySet");
            if (!(keys instanceof Set<?>)) throw new Failure("PLATFORM_RESULT");
            if (((Set<?>) keys).size() > MAX_EXTRAS) throw new Failure("LIMIT_EXCEEDED");
            List<String> names = new ArrayList<String>();
            for (Object key : (Set<?>) keys) {
                if (!(key instanceof String)) throw new Failure("PLATFORM_RESULT");
                names.add(string(key));
            }
            Collections.sort(names);
            Map<String, Object> result = map();
            for (String key : names) {
                Object entry = required(value, "get", new Class<?>[] { String.class }, new Object[] { key });
                result.put(key, primitive(entry));
            }
            return result;
        }

        private Object primitive(Object value) throws Failure {
            if (value == null || value instanceof Boolean || value instanceof Number) return value;
            if (value instanceof CharSequence || value instanceof Character) return string(value);
            if (value.getClass().isArray()) {
                int length = Array.getLength(value);
                if (length > MAX_ARRAY) return omitted("array_limit");
                List<Object> result = new ArrayList<Object>();
                for (int index = 0; index < length; index++) {
                    Object item = Array.get(value, index);
                    if (item != null && !(item instanceof Boolean || item instanceof Number
                            || item instanceof CharSequence || item instanceof Character)) {
                        result.add(omitted("nonprimitive"));
                    } else result.add(primitive(item));
                }
                return result;
            }
            // Do not stringify arbitrary Parcelable/Serializable app objects.
            return omitted("nonprimitive");
        }

        private Object strings(Object value, int maximum) throws Failure {
            if (value == null) return null;
            if (!(value instanceof List<?>)) throw new Failure("PLATFORM_RESULT");
            if (((List<?>) value).size() > maximum) throw new Failure("LIMIT_EXCEEDED");
            List<String> result = new ArrayList<String>();
            for (Object item : (List<?>) value) result.add(string(item));
            return result;
        }

        private Object bounds(Object value) throws Failure {
            try {
                Class<?> rectClass = Class.forName("android.graphics.Rect");
                Object rect = rectClass.getConstructor().newInstance();
                required(value, "getBoundsInScreen", new Class<?>[] { rectClass }, new Object[] { rect });
                List<Integer> bounds = new ArrayList<Integer>();
                for (String key : new String[] { "left", "top", "right", "bottom" }) {
                    bounds.add(Integer.valueOf(rectClass.getField(key).getInt(rect)));
                }
                return bounds;
            } catch (Failure error) { throw error; }
            catch (Throwable error) { throw new Failure("PLATFORM_API"); }
        }

        private String text(Object target, String method) throws Failure { return string(optional(target, method)); }

        private Object optional(Object target, String method) throws Failure {
            try { return invoke(target, method, new Class<?>[0], new Object[0]); }
            catch (NoSuchMethodException error) { unsupported.add(method); return null; }
            catch (Throwable error) { throw new Failure("PLATFORM_API"); }
        }

        private Object required(Object target, String method) throws Failure {
            return required(target, method, new Class<?>[0], new Object[0]);
        }

        private Object required(Object target, String method, Class<?>[] types, Object[] arguments) throws Failure {
            try { return invoke(target, method, types, arguments); }
            catch (Throwable error) { throw new Failure("PLATFORM_API"); }
        }

        private Object invoke(Object target, String name, Class<?>[] types, Object[] arguments) throws Exception {
            checkBudget();
            if (target == null) throw new Failure("PLATFORM_RESULT");
            String key = target.getClass().getName() + "#" + name;
            for (Class<?> type : types) key += ":" + type.getName();
            Method method = methods.get(key);
            if (method == null) {
                method = target.getClass().getMethod(name, types);
                methods.put(key, method);
            }
            try { return method.invoke(target, arguments); }
            catch (InvocationTargetException error) { throw error; }
        }

        private void recycle(Object value) {
            if (value == null) return;
            try { value.getClass().getMethod("recycle").invoke(value); } catch (Throwable ignored) { }
        }

        private void checkBudget() throws Failure {
            if (System.nanoTime() - deadline >= 0) throw new Failure("READ_TIMEOUT");
        }
    }

    private static final class WindowSnapshot {
        final Map<String, Object> values;
        final String focusSignature;
        WindowSnapshot(Map<String, Object> values, String focusSignature) {
            this.values = values;
            this.focusSignature = focusSignature;
        }
    }

    private static Map<String, Object> map() { return new LinkedHashMap<String, Object>(); }
    private static Object omitted(String reason) {
        Map<String, Object> value = map();
        value.put("omitted", Boolean.TRUE);
        value.put("reason", reason);
        return value;
    }
    private static boolean equal(Object first, Object second) { return first == null ? second == null : first.equals(second); }
    private static int number(Object value) throws Failure {
        if (!(value instanceof Integer)) throw new Failure("PLATFORM_RESULT");
        return ((Integer) value).intValue();
    }
    private static boolean bool(Object value) throws Failure {
        if (!(value instanceof Boolean)) throw new Failure("PLATFORM_RESULT");
        return ((Boolean) value).booleanValue();
    }
    private static String string(Object value) throws Failure {
        if (value == null) return null;
        if (!(value instanceof CharSequence || value instanceof Character)) throw new Failure("PLATFORM_RESULT");
        String text = value.toString();
        if (text.length() > MAX_STRING) throw new Failure("LIMIT_EXCEEDED");
        return text;
    }

    /** Bounded ASCII JSON encoder; every non-ASCII UTF-16 unit is escaped. */
    private static final class Json {
        private final StringBuilder buffer = new StringBuilder();
        void append(String value) throws Failure {
            if (value.length() > MAX_OUTPUT - buffer.length()) throw new Failure("LIMIT_EXCEEDED");
            buffer.append(value);
        }
        void field(String name, Object value, boolean first) throws Failure {
            if (!first) append(",");
            quote(name);
            append(":");
            value(value);
        }
        void value(Object value) throws Failure {
            if (value == null) { append("null"); return; }
            if (value instanceof String || value instanceof Character || value instanceof CharSequence) { quote(value.toString()); return; }
            if (value instanceof Boolean) { append(value.toString()); return; }
            if (value instanceof Number) {
                if (value instanceof Float && (Float.isInfinite(((Float) value).floatValue()) || Float.isNaN(((Float) value).floatValue()))
                        || value instanceof Double && (Double.isInfinite(((Double) value).doubleValue()) || Double.isNaN(((Double) value).doubleValue()))) {
                    append("null"); return;
                }
                if (!(value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long
                        || value instanceof Float || value instanceof Double)) throw new Failure("PLATFORM_RESULT");
                append(value.toString()); return;
            }
            if (value instanceof Map<?, ?>) {
                append("{");
                boolean first = true;
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    if (!(entry.getKey() instanceof String)) throw new Failure("PLATFORM_RESULT");
                    field((String) entry.getKey(), entry.getValue(), first);
                    first = false;
                }
                append("}"); return;
            }
            if (value instanceof List<?>) {
                append("[");
                boolean first = true;
                for (Object item : (List<?>) value) {
                    if (!first) append(",");
                    value(item); first = false;
                }
                append("]"); return;
            }
            throw new Failure("PLATFORM_RESULT");
        }
        private void quote(String value) throws Failure {
            if (value.length() > MAX_STRING) throw new Failure("LIMIT_EXCEEDED");
            append("\"");
            for (int index = 0; index < value.length(); index++) {
                char character = value.charAt(index);
                if (character == '\\') append("\\\\");
                else if (character == '"') append("\\\"");
                else if (character >= 0x20 && character <= 0x7e) append(Character.toString(character));
                else {
                    String hex = Integer.toHexString(character);
                    append("\\u" + "0000".substring(hex.length()) + hex);
                }
            }
            append("\"");
        }
        @Override public String toString() { return buffer.toString(); }
    }
}
