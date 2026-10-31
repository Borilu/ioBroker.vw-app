package vw.app.bridge;

import android.os.Bundle;
import com.android.uiautomator.testrunner.UiAutomatorTestRunner;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.security.MessageDigest;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Original adapter action prototype; never selected by the read-only runner.
 *
 * CLI parameters: -e request /data/local/tmp/vw-app-<nonce>.json
 *                 -e out /data/local/tmp/vw-app-<different-nonce>.json
 *
 * Strict request object, all six keys required:
 * {schemaVersion:1, nonce:UUID, action:NAME, target:SELECTOR,
 *  context:{windowId:INTEGER|null,header:SELECTOR}, value:NUMBER|STRING|null}.
 * NAME is setProgress, setText, scrollForward, scrollBackward, or click.
 * SELECTOR has exactly id,description,class,bounds,text,stateDescription,
 * rangeInfo,nodePath. Nullable actual fields match null EXACTLY. nodePath=null
 * means no path constraint; otherwise root is "0", child zero is "0.0", etc.
 * At least id OR description OR nonempty text OR nodePath is required.
 * rangeInfo is null or {type,min,max,current}; type is 0,1,2.
 *
 * All root/header/target expectations must match freshly before the sole action.
 * Caller separately verifies phone, app, vehicle and native timer/location
 * identity and write permission. These identities cannot be proven by this
 * accessibility helper. No retries, injected input, global actions or images.
 * success acknowledges only the API call and readable post-tree, not the
 * requested value, persistence, a vehicle action or synchronization.
 */
public final class AccessibilityActionRunner extends UiAutomatorTestRunner {
    private static final String VW = "com.volkswagen.weconnect";
    private static final String WRAPPER = "com.android.uiautomator.core.UiAutomationShellWrapper";
    private static final int MAX_TEXT = 5000, MAX_REQUEST = 32768, MAX_OUTPUT = 2 * 1024 * 1024;
    private Object params;
    private boolean unsupported;

    @Override public void run(List<String> classes, Bundle parameters, boolean debug, boolean monkey) {
        params = parameters; unsupported = debug || monkey; start();
    }
    @Override protected void start() {
        try {
            if (unsupported) throw new Failure("UNSUPPORTED_OPTIONS");
            String securityMode = optionalParameter("securityMode");
            if (securityMode != null) { security(securityMode); return; }
            Path requestPath = path(parameter("request"));
            Path out = path(parameter("out"));
            if (requestPath.equals(out)) throw new Failure("INVALID_PATH");
            Spec spec = new Spec(Parser.parse(readRequest(requestPath)));
            Outcome outcome = new Outcome();
            Session session = new Session();
            try { session.act(spec, outcome); }
            catch (Failure error) { outcome.error = error.code; }
            catch (Throwable error) { outcome.error = outcome.attempted ? "ACTION_OUTCOME_UNKNOWN" : "PLATFORM_API"; }
            finally {
                if (!session.close() && outcome.error == null) outcome.error = "SESSION_CLEANUP";
            }
            String post = null;
            String postError = null;
            try {
                // The action session is completely disconnected before a new,
                // independent instance of the original read-only session starts.
                post = ExtendedUiDumpRunner.captureJSON();
                if (post.length() > MAX_OUTPUT - 4096) { post = null; postError = "POST_READ_LIMIT"; }
            } catch (Throwable error) { postError = "POST_READ_UNAVAILABLE"; }
            Map<String,Object> result = object();
            result.put("format", "vw-app-accessibility-action-v1");
            result.put("requestNonce", spec.nonce);
            result.put("action", spec.action);
            result.put("actionId", Integer.valueOf(spec.actionId));
            result.put("beforeMatched", Boolean.valueOf(outcome.beforeMatched));
            result.put("actionAttempted", Boolean.valueOf(outcome.attempted));
            result.put("actionAccepted", outcome.accepted);
            result.put("success", Boolean.valueOf(Boolean.TRUE.equals(outcome.accepted)
                    && outcome.error == null && post != null));
            result.put("nativeContextVerifiedByRunner", Boolean.FALSE);
            result.put("errorCode", outcome.error);
            result.put("postReadError", postError);
            Json json = new Json();
            json.value(result);
            String prefix = json.toString();
            String complete = prefix.substring(0, prefix.length() - 1)
                    + ",\"postRead\":" + (post == null ? "null" : post.trim()) + "}\n";
            writeNew(out, complete);
            System.out.println("VW_UI_ACTION_RESULT");
            System.out.flush();
            System.exit(0);
        } catch (Failure error) {
            System.out.println("VW_UI_ACTION_ERROR:" + error.code);
        } catch (Throwable error) {
            System.out.println("VW_UI_ACTION_ERROR:INTERNAL");
        }
        System.out.flush();
        System.exit(2);
    }

    private String parameter(String name) throws Failure {
        try {
            Object value = params.getClass().getMethod("getString", String.class).invoke(params, name);
            if (!(value instanceof String)) throw new Failure("INVALID_PATH");
            return (String)value;
        } catch (Throwable error) { throw new Failure("INVALID_PATH"); }
    }
    private String optionalParameter(String name) throws Failure {
        try {
            Object value = params.getClass().getMethod("getString", String.class).invoke(params, name);
            if (value == null) return null;
            if (!(value instanceof String)) throw new Failure("INVALID_REQUEST");
            return (String)value;
        } catch (Throwable error) { throw new Failure("INVALID_REQUEST"); }
    }
    /** Dedicated stdin/stdout protocol. No files, post-read, PIN echo or retry. */
    private void security(String mode) throws Failure {
        Session session = new Session();
        Map<String,Object> result = object();
        String prefix;
        if ("probe".equals(mode)) {
            String nonce = parameter("nonce");
            if (!uuid(nonce)) throw new Failure("INVALID_REQUEST");
            result.put("format", "vw-app-security-status-v1"); result.put("nonce", nonce);
            result.put("kind", "other"); result.put("operation", null); result.put("contextDigest", null); result.put("errorCode", null);
            try {
                session.open();
                PinContext context = session.pinContext();
                try {
                    result.put("kind", context.kind); result.put("operation", context.operation);
                    if ("pinEmpty".equals(context.kind)) result.put("contextDigest", context.digest);
                    if ("pinUnsupported".equals(context.kind)) result.put("errorCode", "SECURITY_CONTEXT_UNSUPPORTED");
                } finally { session.recycle(context.target); }
            } catch (Throwable error) { result.put("kind", "other"); result.put("operation", null); result.put("contextDigest", null); result.put("errorCode", "SECURITY_CONTEXT_UNAVAILABLE"); }
            finally {
                if (!session.close()) { result.put("kind", "other"); result.put("operation", null); result.put("contextDigest", null); result.put("errorCode", "SECURITY_SESSION_CLEANUP"); }
            }
            prefix = "VW_SECURITY_STATUS_RESULT ";
        } else if ("entry".equals(mode)) {
            Outcome outcome = new Outcome();
            String nonce = null;
            try {
                Map<String,Object> request = record(Parser.parse(stdinRequest()), "schemaVersion,nonce,operation,contextDigest,pin");
                String candidateNonce = string(request.get("nonce"), false);
                if (!uuid(candidateNonce)) throw new Failure("SECURITY_INVALID_REQUEST");
                nonce = candidateNonce;
                String operation = string(request.get("operation"), false), digest = string(request.get("contextDigest"), false);
                String pin = string(request.get("pin"), false);
                if (integer(request.get("schemaVersion")) != 1 || !("unlock".equals(operation) || "lock".equals(operation))
                        || !digest.matches("[a-f0-9]{64}") || !pin.matches("[0-9]{4}")) throw new Failure("SECURITY_INVALID_REQUEST");
                session.open();
                session.enterPin(operation, digest, pin, outcome);
                request.put("pin", null); pin = null;
            } catch (Failure error) { outcome.error = error.code.startsWith("SECURITY_") ? error.code : "SECURITY_CONTEXT_MISMATCH"; }
            catch (Throwable error) { outcome.error = outcome.attempted ? "SECURITY_ACTION_OUTCOME_UNKNOWN" : "SECURITY_CONTEXT_MISMATCH"; }
            finally { if (!session.close() && outcome.error == null) outcome.error = "SECURITY_SESSION_CLEANUP"; }
            result.put("format", "vw-app-security-entry-v1"); result.put("nonce", nonce);
            result.put("beforeMatched", Boolean.valueOf(outcome.beforeMatched)); result.put("actionAttempted", Boolean.valueOf(outcome.attempted));
            result.put("actionAccepted", outcome.accepted); result.put("errorCode", outcome.error);
            prefix = "VW_SECURITY_ENTRY_RESULT ";
        } else throw new Failure("INVALID_REQUEST");
        Json json = new Json(); json.value(result);
        System.out.println(prefix + json.toString()); System.out.flush(); System.exit(0);
    }
    private static boolean uuid(String value) { return value != null && value.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"); }
    private static String stdinRequest() throws Failure {
        byte[] buffer = new byte[4097]; int count = 0;
        try {
            for (;;) {
                int read = System.in.read(buffer, count, buffer.length - count);
                if (read == -1) break;
                count += read;
                if (count >= buffer.length) throw new Failure("SECURITY_INVALID_REQUEST");
            }
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(buffer, 0, count)).toString();
        } catch (Throwable error) { throw new Failure("SECURITY_INVALID_REQUEST"); }
        finally { Arrays.fill(buffer, (byte)0); }
    }
    private static Path path(String value) throws Failure {
        if (value == null || value.contains("..")
                || !value.matches("/data/local/tmp/vw-app-[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.json")) {
            throw new Failure("INVALID_PATH");
        }
        Path result = Paths.get(value);
        if (!result.isAbsolute() || !result.equals(result.normalize())
                || !Paths.get("/data/local/tmp").equals(result.getParent())) throw new Failure("INVALID_PATH");
        return result;
    }
    private static String readRequest(Path path) throws Failure {
        try {
            BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() > MAX_REQUEST) throw new Failure("INVALID_REQUEST");
            ByteBuffer bytes = ByteBuffer.allocate(MAX_REQUEST + 1);
            try (SeekableByteChannel channel = Files.newByteChannel(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
                while (bytes.hasRemaining() && channel.read(bytes) != -1) { }
            }
            if (bytes.position() > MAX_REQUEST) throw new Failure("INVALID_REQUEST");
            bytes.flip();
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(bytes).toString();
        } catch (Throwable error) { throw new Failure("INVALID_REQUEST"); }
    }
    private static void writeNew(Path path, String text) throws Failure {
        if (text.length() > MAX_OUTPUT) throw new Failure("OUTPUT_LIMIT");
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        if (data.length > MAX_OUTPUT) throw new Failure("OUTPUT_LIMIT");
        boolean created = false, complete = false;
        Set<OpenOption> options = new HashSet<OpenOption>();
        options.add(StandardOpenOption.CREATE_NEW); options.add(StandardOpenOption.WRITE); options.add(LinkOption.NOFOLLOW_LINKS);
        try {
            try (SeekableByteChannel channel = Files.newByteChannel(path, options,
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
                created = true;
                ByteBuffer buffer = ByteBuffer.wrap(data);
                while (buffer.hasRemaining()) channel.write(buffer);
            }
            complete = true;
        } catch (Throwable error) { throw new Failure("OUTPUT_IO"); }
        finally { if (created && !complete) try { Files.deleteIfExists(path); } catch (Throwable ignored) { } }
    }

    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }
    private static final class Outcome {
        boolean beforeMatched, attempted;
        Boolean accepted = null; // No API response exists before an invocation.
        String error;
    }
    private static final class Spec {
        final String nonce, action;
        final int actionId;
        final Integer windowId;
        final Selector target, header;
        final Object value;
        Spec(Object input) throws Failure {
            Map<String,Object> data = record(input, "schemaVersion,nonce,action,target,context,value");
            if (integer(data.get("schemaVersion")) != 1) throw new Failure("INVALID_REQUEST");
            nonce = string(data.get("nonce"), false);
            if (!nonce.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) throw new Failure("INVALID_REQUEST");
            action = string(data.get("action"), false);
            if ("setProgress".equals(action)) actionId = 16908349;
            else if ("setText".equals(action)) actionId = 2097152;
            else if ("scrollForward".equals(action)) actionId = 4096;
            else if ("scrollBackward".equals(action)) actionId = 8192;
            else if ("click".equals(action)) actionId = 16;
            else throw new Failure("INVALID_REQUEST");
            target = new Selector(data.get("target"));
            Map<String,Object> context = record(data.get("context"), "windowId,header");
            windowId = context.get("windowId") == null ? null : Integer.valueOf(integer(context.get("windowId")));
            if (windowId != null && windowId.intValue() < 0) throw new Failure("INVALID_REQUEST");
            header = new Selector(context.get("header"));
            value = data.get("value");
            if ("setProgress".equals(action)) {
                finite(value);
                if (target.range == null) throw new Failure("INVALID_REQUEST");
            } else if ("setText".equals(action)) string(value, true);
            else if (value != null) throw new Failure("INVALID_REQUEST");
        }
    }
    private static final class Selector {
        final String id, description, className, text, state, nodePath;
        final int[] bounds;
        final Map<String,Object> range;
        Selector(Object input) throws Failure {
            Map<String,Object> data = record(input, "id,description,class,bounds,text,stateDescription,rangeInfo,nodePath");
            id = nullable(data.get("id")); description = nullable(data.get("description"));
            className = string(data.get("class"), false); text = nullable(data.get("text"));
            state = nullable(data.get("stateDescription")); nodePath = nullable(data.get("nodePath"));
            if (nodePath != null && (nodePath.length() > 205 || !nodePath.matches("0(?:\\.(?:0|[1-9][0-9]{0,3})){0,40}"))) throw new Failure("INVALID_REQUEST");
            if ((id == null || id.isEmpty()) && (description == null || description.isEmpty())
                    && (text == null || text.isEmpty()) && nodePath == null) throw new Failure("INVALID_REQUEST");
            Object raw = data.get("bounds");
            if (!(raw instanceof List<?>) || ((List<?>)raw).size() != 4) throw new Failure("INVALID_REQUEST");
            bounds = new int[4];
            for (int index = 0; index < 4; index++) {
                bounds[index] = integer(((List<?>)raw).get(index));
                if (bounds[index] < 0 || bounds[index] > 32768) throw new Failure("INVALID_REQUEST");
            }
            if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Failure("INVALID_REQUEST");
            if (data.get("rangeInfo") == null) range = null;
            else {
                range = record(data.get("rangeInfo"), "type,min,max,current");
                int type = integer(range.get("type"));
                if (type < 0 || type > 2) throw new Failure("INVALID_REQUEST");
                float min = finite(range.get("min")), max = finite(range.get("max")), current = finite(range.get("current"));
                if (min > max || current < min || current > max) throw new Failure("INVALID_REQUEST");
            }
        }
    }

    private static final class Session {
        Integer sessionWindowId;
        int[] sessionBounds;
        Object wrapper, automation, info;
        int oldFlags;
        boolean connected;
        final long deadline = System.nanoTime() + 12000000000L;
        final Map<String,Method> methods = new HashMap<String,Method>();

        void open() throws Failure {
            try {
                wrapper = Class.forName(WRAPPER).getConstructor().newInstance();
                call(wrapper, "connect"); connected = true;
                automation = call(wrapper, "getUiAutomation");
                info = call(automation, "getServiceInfo");
                Class<?> infoClass = Class.forName("android.accessibilityservice.AccessibilityServiceInfo");
                oldFlags = infoClass.getField("flags").getInt(info);
                int flags = oldFlags | infoClass.getField("FLAG_INCLUDE_NOT_IMPORTANT_VIEWS").getInt(null)
                        | infoClass.getField("FLAG_RETRIEVE_INTERACTIVE_WINDOWS").getInt(null);
                infoClass.getField("flags").setInt(info, flags);
                call(automation, "setServiceInfo", new Class<?>[]{infoClass}, new Object[]{info});
                idle();
            } catch (Failure error) { throw error; }
            catch (Throwable error) { throw new Failure("PLATFORM_API"); }
        }
        void act(Spec spec, Outcome outcome) throws Failure {
            Object root = null, current = null, target = null;
            try {
                open();
                root = call(automation, "getRootInActiveWindow");
                checkContext(root, spec);
                rejectSecurity(root, 0, new int[]{0});
                if (!Boolean.TRUE.equals(call(root, "refresh"))) throw new Failure("STALE_NODE");
                Match match = new Match();
                try {
                    find(root, "0", 0, spec, match, true);
                    if (match.targets != 1 || match.headers != 1 || equal(match.path, match.headerPath)) throw new Failure("SELECTOR_NOT_UNIQUE");
                    target = match.target; match.target = null;
                } finally { recycle(match.target); }
                if (!Boolean.TRUE.equals(call(target, "refresh")) || !matches(target, spec.target, match.path, true)) throw new Failure("STALE_NODE");
                current = call(automation, "getRootInActiveWindow");
                checkContext(current, spec);
                rejectSecurity(current, 0, new int[]{0});
                if (!Boolean.TRUE.equals(call(current, "refresh"))) throw new Failure("STALE_NODE");
                Match verify = new Match();
                try {
                    find(current, "0", 0, spec, verify, true);
                    if (verify.targets != 1 || verify.headers != 1 || equal(verify.path, verify.headerPath)) throw new Failure("SELECTOR_NOT_UNIQUE");
                    // Act on the node from the second, fresh traversal. A moved
                    // former node must never inherit the replacement's path.
                    recycle(target);
                    target = verify.target; verify.target = null;
                } finally { recycle(verify.target); }
                if (!Boolean.TRUE.equals(call(target, "refresh")) || !matches(target, spec.target, verify.path, true)) throw new Failure("STALE_NODE");
                checkContext(current, spec);
                rejectSecurity(current, 0, new int[]{0});
                if (!supports(target, spec.actionId)) throw new Failure("ACTION_UNAVAILABLE");
                Object arguments = null;
                if ("setProgress".equals(spec.action)) {
                    float progress = finite(spec.value);
                    Object range = call(target, "getRangeInfo");
                    if (range == null || progress < finite(call(range, "getMin")) || progress > finite(call(range, "getMax"))) throw new Failure("PROGRESS_OUT_OF_RANGE");
                    arguments = Class.forName("android.os.Bundle").getConstructor().newInstance();
                    String key = (String)Class.forName("android.view.accessibility.AccessibilityNodeInfo").getField("ACTION_ARGUMENT_PROGRESS_VALUE").get(null);
                    call(arguments, "putFloat", new Class<?>[]{String.class,float.class}, new Object[]{key,Float.valueOf(progress)});
                } else if ("setText".equals(spec.action)) {
                    if (!Boolean.TRUE.equals(call(target, "isEditable")) || Boolean.TRUE.equals(call(target, "isPassword"))) throw new Failure("TEXT_TARGET_UNAVAILABLE");
                    arguments = Class.forName("android.os.Bundle").getConstructor().newInstance();
                    String key = (String)Class.forName("android.view.accessibility.AccessibilityNodeInfo").getField("ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE").get(null);
                    call(arguments, "putCharSequence", new Class<?>[]{String.class,CharSequence.class}, new Object[]{key,(String)spec.value});
                } else if ("click".equals(spec.action) && !Boolean.TRUE.equals(call(target, "isClickable"))) throw new Failure("ACTION_UNAVAILABLE");
                outcome.beforeMatched = true;
                outcome.attempted = true; // From here, missing results must never cause a retry.
                try {
                    Object accepted = call(target, "performAction",
                            new Class<?>[]{int.class,Class.forName("android.os.Bundle")},
                            new Object[]{Integer.valueOf(spec.actionId),arguments});
                    if (!(accepted instanceof Boolean)) throw new Failure("ACTION_OUTCOME_UNKNOWN");
                    outcome.accepted = (Boolean)accepted;
                    if (!outcome.accepted.booleanValue()) outcome.error = "ACTION_NOT_ACCEPTED";
                } catch (Throwable error) {
                    outcome.accepted = null;
                    outcome.error = "ACTION_OUTCOME_UNKNOWN";
                }
                try { idle(); } catch (Throwable error) { if (outcome.error == null) outcome.error = "POST_ACTION_WAIT_FAILED"; }
            } catch (Failure error) { throw error; }
            catch (Throwable error) { throw new Failure(outcome.attempted ? "ACTION_OUTCOME_UNKNOWN" : "PLATFORM_API"); }
            finally { recycle(root); if (current != root) recycle(current); recycle(target); }
        }
        void checkContext(Object root, Spec spec) throws Failure {
            checkPackage(root);
            int currentWindowId = integer(call(root,"getWindowId"));
            if (spec != null && spec.windowId != null && currentWindowId != spec.windowId.intValue()) throw new Failure("WINDOW_CHANGED");
            if (sessionWindowId != null && currentWindowId != sessionWindowId.intValue()) throw new Failure("WINDOW_CHANGED");
            sessionWindowId = Integer.valueOf(currentWindowId);
            Object raw = call(automation,"getWindows");
            if (!(raw instanceof List<?>) || ((List<?>)raw).size() > 16) throw new Failure("WINDOW_CONTEXT_UNAVAILABLE");
            int active = 0, focused = 0, applicationWindows = 0;
            for (Object window : (List<?>)raw) {
                Object windowRoot = null;
                try {
                    boolean a = Boolean.TRUE.equals(call(window,"isActive")), f = Boolean.TRUE.equals(call(window,"isFocused"));
                    windowRoot = call(window,"getRoot");
                    boolean vw = windowRoot != null && VW.equals(nullable(call(windowRoot,"getPackageName")));
                    int type = integer(call(window,"getType"));
                    if (vw && type == 1) applicationWindows++;
                    if (!a && !f) continue;
                    checkPackage(windowRoot);
                    if (type != 1 || integer(call(window,"getId")) != currentWindowId) throw new Failure("WINDOW_CHANGED");
                    int[] geometry = rectangle(window);
                    if (geometry[0] < 0 || geometry[1] < 0 || geometry[2] <= geometry[0] || geometry[3] <= geometry[1]) throw new Failure("WINDOW_CHANGED");
                    if (sessionBounds != null && !java.util.Arrays.equals(sessionBounds, geometry)) throw new Failure("WINDOW_CHANGED");
                    sessionBounds = geometry;
                    if (a) active++; if (f) focused++;
                } finally { recycle(windowRoot); recycle(window); }
            }
            if (active != 1 || focused != 1 || applicationWindows != 1 || sessionBounds == null) throw new Failure("AMBIGUOUS_WINDOW");
        }
        void rejectSecurity(Object node, int depth, int[] visited) throws Failure {
            if (depth > 40 || ++visited[0] > 2000) throw new Failure("TREE_LIMIT");
            checkPackage(node);
            String text = nullable(call(node,"getText")), description = nullable(call(node,"getContentDescription"));
            if (Boolean.TRUE.equals(call(node,"isPassword")) || pinLabel(text) || pinLabel(description)) throw new Failure("SENSITIVE_UI");
            int count = integer(call(node,"getChildCount"));
            if (count < 0 || count > 2000) throw new Failure("TREE_LIMIT");
            for (int index=0; index<count; index++) {
                Object child = call(node,"getChild",new Class<?>[]{int.class},new Object[]{Integer.valueOf(index)});
                try { rejectSecurity(child,depth+1,visited); } finally { recycle(child); }
            }
        }
        boolean inside(int[] bounds) {
            return sessionBounds != null && bounds[0] >= sessionBounds[0] && bounds[1] >= sessionBounds[1]
                    && bounds[2] <= sessionBounds[2] && bounds[3] <= sessionBounds[3]
                    && bounds[2] > bounds[0] && bounds[3] > bounds[1];
        }
        PinContext pinContext() throws Failure {
            Object root = null;
            PinContext context = new PinContext();
            try {
                root = call(automation,"getRootInActiveWindow"); checkContext(root,null);
                if (!Boolean.TRUE.equals(call(root,"refresh"))) throw new Failure("STALE_NODE");
                scanPin(root,"0",0,true,true,context);
                checkContext(root,null);
                context.finish();
                return context;
            } catch (Failure error) { recycle(context.target); throw error; }
            finally { recycle(root); }
        }
        void scanPin(Object node, String path, int depth, boolean ancestors, boolean staticAncestors, PinContext context) throws Failure {
            if (depth > 40 || ++context.visited > 2000) throw new Failure("TREE_LIMIT");
            checkPackage(node);
            int[] bounds = rectangle(node);
            boolean staticAllowed = staticAncestors && inside(bounds) && Boolean.TRUE.equals(call(node,"isEnabled"));
            boolean allowed = ancestors && staticAllowed && Boolean.TRUE.equals(call(node,"isVisibleToUser"));
            String cls = nullable(call(node,"getClassName")), text = nullable(call(node,"getText")), description = nullable(call(node,"getContentDescription"));
            boolean password = Boolean.TRUE.equals(call(node,"isPassword"));
            if (password || pinLabel(text) || pinLabel(description)) context.sensitive = true;
            if (allowed && description != null && description.startsWith("Ihr Fahrzeug: ")) context.homeVehicle++;
            if (allowed && ("Fahrzeug. Verriegelt. Details öffnen".equals(description) || "Fahrzeug. Entriegelt. Details öffnen".equals(description))) context.homeAccess++;
            if ("S-PIN eingeben".equals(text) && "android.widget.TextView".equals(cls)) {
                context.headers++;
                if (allowed) { context.headerPath=path; context.headerBounds=bounds; }
            }
            if ("Show PIN".equals(text) && "android.widget.TextView".equals(cls)) {
                context.shows++;
                if (allowed) context.showPath=path;
            }
            String footerOperation = null;
            if ("Bitte stellen Sie vor dem Entriegeln sicher, dass Ihr Fahrzeug für Unbefugte nicht zugänglich ist.".equals(text)) footerOperation="unlock";
            if ("Bitte stellen Sie vor dem Verriegeln sicher, dass sich keine weiteren Personen im Fahrzeug befinden. Die (ausstattungsabhängige) SAFE-Verriegelung ist nicht aktiv.".equals(text)) footerOperation="lock";
            if (footerOperation != null && "android.widget.TextView".equals(cls)) {
                context.footers++;
                // On both observed forms the keyboard obscures this exact
                // noninteractive footer. Visibility is not an input exception:
                // enabled, bounded ancestry is still required for static context.
                if (staticAllowed) { context.footerPath=path; context.footerBounds=bounds; context.footerOperation=footerOperation; }
            }
            if ("android.widget.EditText".equals(cls)) {
                context.fields++;
                // The observed VW Compose S-PIN field reports isPassword=false.
                // Only this independently recognized form permits that exception.
                if (allowed && !password && nullable(call(node,"getViewIdResourceName")) == null
                        && integer(call(node,"getWindowId"))==sessionWindowId.intValue()
                        && Boolean.TRUE.equals(call(node,"isFocused")) && Boolean.TRUE.equals(call(node,"isEditable")) && supports(node,2097152)) {
                    context.fieldPath=path; context.fieldBounds=bounds;
                    context.empty=(text == null || text.length()==0) && "Leer".equals(nullable(call(node,"getStateDescription")));
                    context.nonEmpty=text != null && text.length()>0;
                    String fieldError=nullable(call(node,"getError"));
                    context.fieldError=fieldError != null && fieldError.length()>0;
                    try {
                        Class<?> nodeClass=Class.forName("android.view.accessibility.AccessibilityNodeInfo");
                        recycle(context.target); context.target=nodeClass.getMethod("obtain",nodeClass).invoke(null,node);
                    } catch (Throwable error) { throw new Failure("PLATFORM_API"); }
                }
            }
            int count=integer(call(node,"getChildCount"));
            if(count<0||count>2000)throw new Failure("TREE_LIMIT");
            for(int index=0;index<count;index++){
                Object child=call(node,"getChild",new Class<?>[]{int.class},new Object[]{Integer.valueOf(index)});
                try{scanPin(child,path+"."+index,depth+1,allowed,staticAllowed,context);}finally{recycle(child);}
            }
        }
        void validatePinTarget(PinContext context) throws Failure {
            Object node=context.target;
            checkPackage(node);
            if(!"android.widget.EditText".equals(nullable(call(node,"getClassName")))
                    ||nullable(call(node,"getViewIdResourceName"))!=null||Boolean.TRUE.equals(call(node,"isPassword"))
                    ||integer(call(node,"getWindowId"))!=sessionWindowId.intValue()
                    ||!Boolean.TRUE.equals(call(node,"isVisibleToUser"))||!Boolean.TRUE.equals(call(node,"isEnabled"))
                    ||!Boolean.TRUE.equals(call(node,"isFocused"))||!Boolean.TRUE.equals(call(node,"isEditable"))
                    ||!Arrays.equals(context.fieldBounds,rectangle(node))||!inside(rectangle(node))||!supports(node,2097152))throw new Failure("SECURITY_CONTEXT_MISMATCH");
            String value=nullable(call(node,"getText")),state=nullable(call(node,"getStateDescription")),error=nullable(call(node,"getError"));
            if(value!=null&&value.length()!=0||!"Leer".equals(state)||error!=null&&error.length()!=0)throw new Failure("SECURITY_CONTEXT_MISMATCH");
        }
        void enterPin(String operation, String digest, String pin, Outcome outcome) throws Failure {
            PinContext first=null, current=null;
            Object arguments=null,activeRoot=null;
            try {
                first=pinContext();
                if(!"pinEmpty".equals(first.kind)||!operation.equals(first.operation)||!digest.equals(first.digest))throw new Failure("SECURITY_CONTEXT_MISMATCH");
                recycle(first.target); first.target=null;
                current=pinContext();
                if(!"pinEmpty".equals(current.kind)||!operation.equals(current.operation)||!digest.equals(current.digest)
                        ||!Boolean.TRUE.equals(call(current.target,"refresh")))throw new Failure("SECURITY_CONTEXT_MISMATCH");
                validatePinTarget(current);
                // Refresh can replace all field metadata and its ancestry. A
                // third whole-form scan must match after it. Act only on that
                // fresh traversal's node, without another unchecked refresh.
                recycle(current.target);current.target=null;
                current=pinContext();
                if(!"pinEmpty".equals(current.kind)||!operation.equals(current.operation)||!digest.equals(current.digest))throw new Failure("SECURITY_CONTEXT_MISMATCH");
                activeRoot=call(automation,"getRootInActiveWindow");checkContext(activeRoot,null);
                validatePinTarget(current);
                try {
                    arguments=Class.forName("android.os.Bundle").getConstructor().newInstance();
                    String key=(String)Class.forName("android.view.accessibility.AccessibilityNodeInfo").getField("ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE").get(null);
                    call(arguments,"putCharSequence",new Class<?>[]{String.class,CharSequence.class},new Object[]{key,pin});
                } catch(Throwable error){throw new Failure("SECURITY_ACTION_UNAVAILABLE");}
                outcome.beforeMatched=true; outcome.attempted=true;
                try {
                    Object accepted=call(current.target,"performAction",new Class<?>[]{int.class,Class.forName("android.os.Bundle")},new Object[]{Integer.valueOf(2097152),arguments});
                    if(!(accepted instanceof Boolean))throw new Failure("SECURITY_ACTION_OUTCOME_UNKNOWN");
                    outcome.accepted=(Boolean)accepted;
                    if(!outcome.accepted.booleanValue())outcome.error="SECURITY_ACTION_NOT_ACCEPTED";
                } catch(Throwable error){outcome.accepted=null;outcome.error="SECURITY_ACTION_OUTCOME_UNKNOWN";}
                // Auto-submit occurs after the fourth digit. Do not read any UI
                // node, wait for a result tree, press Enter or issue another action.
            } finally {
                if(arguments!=null)try{call(arguments,"clear");}catch(Throwable ignored){}
                if(first!=null)recycle(first.target);if(current!=null)recycle(current.target);
                recycle(activeRoot);
            }
        }
        void find(Object node, String path, int depth, Spec spec, Match match, boolean ancestorsAllowed) throws Failure {
            if (depth > 40 || ++match.visited > 2000) throw new Failure("TREE_LIMIT");
            checkPackage(node);
            boolean allowed = ancestorsAllowed && Boolean.TRUE.equals(call(node,"isEnabled"))
                    && (Boolean.TRUE.equals(call(node,"isVisibleToUser")) || wheelWrapper(node,spec));
            if (allowed && matches(node,spec.header,path,false)) { match.headers++; match.headerPath = path; }
            if (allowed && matches(node,spec.target,path,true)) {
                match.targets++;
                if (match.targets == 1) {
                    try {
                        Class<?> cls = Class.forName("android.view.accessibility.AccessibilityNodeInfo");
                        match.target = cls.getMethod("obtain",cls).invoke(null,node); match.path = path;
                    } catch (Throwable error) { throw new Failure("PLATFORM_API"); }
                }
            }
            if (match.targets > 1 || match.headers > 1) throw new Failure("SELECTOR_NOT_UNIQUE");
            int children = integer(call(node,"getChildCount"));
            if (children < 0 || children > 2000) throw new Failure("TREE_LIMIT");
            for (int i=0;i<children;i++) {
                Object child = call(node,"getChild",new Class<?>[]{int.class},new Object[]{Integer.valueOf(i)});
                if (child == null) throw new Failure("STALE_NODE");
                try { find(child,path+"."+i,depth+1,spec,match,allowed); } finally { recycle(child); }
            }
        }
        boolean wheelWrapper(Object node, Spec spec) throws Failure {
            // One observed Compose wheel wrapper lies about visibility. This
            // exception is restricted to time progress actions and its exact
            // noninteractive topology, never to arbitrary hidden containers.
            if (!"setProgress".equals(spec.action) || !"Zeit einstellen".equals(spec.header.description)
                    || !("Hour".equals(spec.target.description) || "Minute".equals(spec.target.description))
                    || !"android.view.View".equals(nullable(call(node,"getClassName")))
                    || nullable(call(node,"getViewIdResourceName")) != null
                    || nullable(call(node,"getText")) != null || nullable(call(node,"getContentDescription")) != null
                    || Boolean.TRUE.equals(call(node,"isClickable")) || Boolean.TRUE.equals(call(node,"isCheckable"))
                    || Boolean.TRUE.equals(call(node,"isScrollable")) || Boolean.TRUE.equals(call(node,"isImportantForAccessibility"))
                    || integer(call(node,"getChildCount")) != 1) return false;
            Object child = call(node,"getChild",new Class<?>[]{int.class},new Object[]{Integer.valueOf(0)});
            try {
                checkPackage(child);
                String caption = nullable(call(child,"getContentDescription"));
                if (!Boolean.TRUE.equals(call(child,"isVisibleToUser")) || !Boolean.TRUE.equals(call(child,"isEnabled"))
                        || !"android.view.View".equals(nullable(call(child,"getClassName")))
                        || caption == null || !caption.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")
                        || !java.util.Arrays.equals(rectangle(node),rectangle(child))) return false;
                int hours = 0, minutes = 0, count = integer(call(child,"getChildCount"));
                if (count < 2 || count > 8) return false;
                for (int index=0; index<count; index++) {
                    Object item = call(child,"getChild",new Class<?>[]{int.class},new Object[]{Integer.valueOf(index)});
                    try {
                        checkPackage(item);
                        String label = nullable(call(item,"getContentDescription"));
                        if (!"Hour".equals(label) && !"Minute".equals(label)) continue;
                        if (!Boolean.TRUE.equals(call(item,"isVisibleToUser")) || !Boolean.TRUE.equals(call(item,"isEnabled"))
                                || !"android.widget.SeekBar".equals(nullable(call(item,"getClassName")))
                                || call(item,"getRangeInfo") == null || !supports(item,16908349)) return false;
                        if ("Hour".equals(label)) hours++; else minutes++;
                    } finally { recycle(item); }
                }
                return hours == 1 && minutes == 1;
            } finally { recycle(child); }
        }
        int[] rectangle(Object node) throws Failure {
            try {
                Class<?> cls=Class.forName("android.graphics.Rect"); Object rect=cls.getConstructor().newInstance();
                call(node,"getBoundsInScreen",new Class<?>[]{cls},new Object[]{rect});
                String[] keys={"left","top","right","bottom"}; int[] result=new int[4];
                for(int index=0;index<4;index++) result[index]=cls.getField(keys[index]).getInt(rect);
                return result;
            } catch(Failure error){throw error;} catch(Throwable error){throw new Failure("PLATFORM_API");}
        }
        boolean matches(Object node, Selector s, String path, boolean target) throws Failure {
            if (!Boolean.TRUE.equals(call(node,"isVisibleToUser")) || target && !Boolean.TRUE.equals(call(node,"isEnabled"))) return false;
            if (sessionBounds == null || s.bounds[0] < sessionBounds[0] || s.bounds[1] < sessionBounds[1]
                    || s.bounds[2] > sessionBounds[2] || s.bounds[3] > sessionBounds[3]) return false;
            if (s.nodePath != null && !s.nodePath.equals(path)) return false;
            if (!equal(s.className,nullable(call(node,"getClassName"))) || !equal(s.id,nullable(call(node,"getViewIdResourceName")))
                    || !equal(s.description,nullable(call(node,"getContentDescription")))
                    || !equal(s.text,nullable(call(node,"getText"))) || !equal(s.state,nullable(call(node,"getStateDescription")))) return false;
            try {
                Class<?> cls=Class.forName("android.graphics.Rect"); Object rect=cls.getConstructor().newInstance();
                call(node,"getBoundsInScreen",new Class<?>[]{cls},new Object[]{rect});
                String[] keys={"left","top","right","bottom"};
                for(int i=0;i<4;i++) if(cls.getField(keys[i]).getInt(rect)!=s.bounds[i]) return false;
            } catch(Failure error){throw error;} catch(Throwable error){throw new Failure("PLATFORM_API");}
            Object range=call(node,"getRangeInfo");
            if(s.range==null)return range==null;
            if(range==null||integer(call(range,"getType"))!=integer(s.range.get("type")))return false;
            String[] keys={"min","max","current"}, getters={"getMin","getMax","getCurrent"};
            for(int i=0;i<3;i++) if(Float.floatToIntBits(finite(call(range,getters[i])))!=Float.floatToIntBits(finite(s.range.get(keys[i]))))return false;
            return true;
        }
        boolean supports(Object node,int id)throws Failure{
            Object raw=call(node,"getActionList");
            if(!(raw instanceof List<?>)||((List<?>)raw).size()>64)throw new Failure("ACTION_UNAVAILABLE");
            for(Object action:(List<?>)raw)if(integer(call(action,"getId"))==id)return true;
            return false;
        }
        void checkPackage(Object node)throws Failure{
            if(node==null||!VW.equals(nullable(call(node,"getPackageName"))))throw new Failure("ACTIVE_WINDOW_NOT_VW");
        }
        void idle()throws Failure{
            try { invoke(automation,"waitForIdle",new Class<?>[]{long.class,long.class},new Object[]{Long.valueOf(100),Long.valueOf(1500)}); }
            catch(InvocationTargetException error){if(!(error.getCause() instanceof java.util.concurrent.TimeoutException))throw new Failure("PLATFORM_API");}
            catch(Failure error){throw error;}catch(Throwable error){throw new Failure("PLATFORM_API");}
        }
        Object call(Object target,String method)throws Failure{return call(target,method,new Class<?>[0],new Object[0]);}
        Object call(Object target,String method,Class<?>[] types,Object[] args)throws Failure{
            try{return invoke(target,method,types,args);}catch(Failure error){throw error;}catch(Throwable error){throw new Failure("PLATFORM_API");}
        }
        Object invoke(Object target,String name,Class<?>[] types,Object[] args)throws Exception{
            if(System.nanoTime()-deadline>=0)throw new Failure("ACTION_TIMEOUT");
            if(target==null)throw new Failure("PLATFORM_RESULT");
            String key=target.getClass().getName()+"#"+name;
            for(Class<?> cls:types)key+=":"+cls.getName();
            Method method=methods.get(key);
            if(method==null){method=target.getClass().getMethod(name,types);methods.put(key,method);}
            return method.invoke(target,args);
        }
        boolean close(){
            boolean ok=true;
            if(automation!=null&&info!=null)try{
                info.getClass().getField("flags").setInt(info,oldFlags);
                automation.getClass().getMethod("setServiceInfo",info.getClass()).invoke(automation,info);
            }catch(Throwable error){ok=false;}
            if(wrapper!=null)try{wrapper.getClass().getMethod("disconnect").invoke(wrapper);}catch(Throwable error){if(connected)ok=false;}
            return ok;
        }
        void recycle(Object node){if(node!=null)try{node.getClass().getMethod("recycle").invoke(node);}catch(Throwable ignored){}}
    }
    private static final class Match {int visited,targets,headers;Object target;String path,headerPath;}
    private static boolean pinLabel(String value){return value!=null&&value.contains("S-PIN eingeben");}
    private static final class PinContext {
        int visited,headers,fields,shows,footers,homeVehicle,homeAccess;
        boolean sensitive,empty,nonEmpty,fieldError;
        String kind="other",operation,digest,headerPath,fieldPath,showPath,footerPath,footerOperation;
        int[] headerBounds,fieldBounds,footerBounds;
        Object target;
        void finish() throws Failure {
            if(!sensitive){if(homeVehicle==1&&homeAccess==1&&fields==0)kind="home";return;}
            kind="pinUnsupported";
            if(headers!=1||fields!=1||shows!=1||footers!=1||headerPath==null||fieldPath==null||showPath==null||footerPath==null
                    ||fieldError||!parent(headerPath).equals(parent(fieldPath))||!parent(footerPath).equals(parent(fieldPath))
                    ||!showPath.startsWith(fieldPath+".")||headerBounds[3]>fieldBounds[1]||footerBounds[1]<fieldBounds[3])return;
            operation=footerOperation;
            if(nonEmpty){kind="pinNonEmpty";return;}
            if(!empty)return;
            kind="pinEmpty";
            try{
                String context="vw-app-pin-context-v1|"+operation+"|"+headerPath+"|"+Arrays.toString(headerBounds)+"|"+fieldPath+"|"+Arrays.toString(fieldBounds)+"|"+showPath+"|"+footerPath+"|"+Arrays.toString(footerBounds);
                byte[] hash=MessageDigest.getInstance("SHA-256").digest(context.getBytes(StandardCharsets.UTF_8));
                StringBuilder out=new StringBuilder();for(byte value:hash){int n=value&255;if(n<16)out.append('0');out.append(Integer.toHexString(n));}digest=out.toString();
            }catch(Throwable error){throw new Failure("SECURITY_CONTEXT_MISMATCH");}
        }
        static String parent(String path){int dot=path.lastIndexOf('.');return dot<0?"":path.substring(0,dot);}
    }

    private static Map<String,Object> object(){return new LinkedHashMap<String,Object>();}
    @SuppressWarnings("unchecked") private static Map<String,Object> record(Object value,String keys)throws Failure{
        if(!(value instanceof Map<?,?>))throw new Failure("INVALID_REQUEST");
        Map<String,Object> input=(Map<String,Object>)value;
        String[] allowed=keys.split(",");
        if(input.size()!=allowed.length)throw new Failure("INVALID_REQUEST");
        for(String key:allowed)if(!input.containsKey(key))throw new Failure("INVALID_REQUEST");
        return input;
    }
    private static int integer(Object value)throws Failure{
        if(!(value instanceof Number))throw new Failure("INVALID_REQUEST");
        double number=((Number)value).doubleValue();
        if(Double.isNaN(number)||Double.isInfinite(number)||number!=Math.rint(number)||number<Integer.MIN_VALUE||number>Integer.MAX_VALUE)throw new Failure("INVALID_REQUEST");
        return (int)number;
    }
    private static float finite(Object value)throws Failure{
        if(!(value instanceof Number))throw new Failure("INVALID_REQUEST");
        float number=((Number)value).floatValue();
        if(Float.isNaN(number)||Float.isInfinite(number))throw new Failure("INVALID_REQUEST");
        return number;
    }
    private static String nullable(Object value)throws Failure{return value==null?null:string(value,true);}
    private static String string(Object value,boolean emptyAllowed)throws Failure{
        if(!(value instanceof CharSequence)||((CharSequence)value).length()>MAX_TEXT||!emptyAllowed&&((CharSequence)value).length()==0)throw new Failure("INVALID_REQUEST");
        return value.toString();
    }
    private static boolean equal(Object a,Object b){return a==null?b==null:a.equals(b);}

    /** Small strict JSON reader: duplicates, comments, extra data and huge inputs fail. */
    private static final class Parser {
        final String text;int at;
        Parser(String text){this.text=text;}
        static Object parse(String text)throws Failure{
            Parser parser=new Parser(text);Object value=parser.value(0);parser.space();
            if(parser.at!=text.length())throw new Failure("INVALID_REQUEST");return value;
        }
        void space(){while(at<text.length()&&" \t\r\n".indexOf(text.charAt(at))>=0)at++;}
        Object value(int depth)throws Failure{
            if(depth>10)throw new Failure("INVALID_REQUEST");space();
            if(at>=text.length())throw new Failure("INVALID_REQUEST");
            char c=text.charAt(at);
            if(c=='"')return quoted();
            if(c=='{'){
                at++;Map<String,Object> result=object();space();if(take('}'))return result;
                do{space();if(at>=text.length()||text.charAt(at)!='"')throw new Failure("INVALID_REQUEST");
                    String key=quoted();if(result.containsKey(key)||result.size()>=24)throw new Failure("INVALID_REQUEST");
                    space();need(':');result.put(key,value(depth+1));space();if(take('}'))return result;need(',');
                }while(true);
            }
            if(c=='['){
                at++;List<Object> result=new ArrayList<Object>();space();if(take(']'))return result;
                do{if(result.size()>=64)throw new Failure("INVALID_REQUEST");result.add(value(depth+1));space();if(take(']'))return result;need(',');}while(true);
            }
            for(String token:new String[]{"null","true","false"})if(text.startsWith(token,at)){at+=token.length();return token.equals("null")?null:Boolean.valueOf(token);}
            int start=at;if(take('-')&&at==text.length())throw new Failure("INVALID_REQUEST");
            if(take('0')){}else{if(at>=text.length()||text.charAt(at)<'1'||text.charAt(at)>'9')throw new Failure("INVALID_REQUEST");digits();}
            if(take('.')){int p=at;digits();if(p==at)throw new Failure("INVALID_REQUEST");}
            if(at<text.length()&&(text.charAt(at)=='e'||text.charAt(at)=='E')){at++;if(at<text.length()&&(text.charAt(at)=='+'||text.charAt(at)=='-'))at++;int p=at;digits();if(p==at)throw new Failure("INVALID_REQUEST");}
            try{Double number=Double.valueOf(text.substring(start,at));if(number.isNaN()||number.isInfinite())throw new Failure("INVALID_REQUEST");return number;}catch(NumberFormatException error){throw new Failure("INVALID_REQUEST");}
        }
        void digits(){while(at<text.length()&&text.charAt(at)>='0'&&text.charAt(at)<='9')at++;}
        boolean take(char expected){if(at<text.length()&&text.charAt(at)==expected){at++;return true;}return false;}
        void need(char expected)throws Failure{space();if(!take(expected))throw new Failure("INVALID_REQUEST");}
        String quoted()throws Failure{
            need('"');StringBuilder result=new StringBuilder();
            while(at<text.length()){
                char c=text.charAt(at++);
                if(c=='"'){
                    for(int i=0;i<result.length();i++){char u=result.charAt(i);if(Character.isHighSurrogate(u)){if(++i>=result.length()||!Character.isLowSurrogate(result.charAt(i)))throw new Failure("INVALID_REQUEST");}else if(Character.isLowSurrogate(u))throw new Failure("INVALID_REQUEST");}
                    return result.toString();
                }
                if(c<' ')throw new Failure("INVALID_REQUEST");
                if(c=='\\'){
                    if(at>=text.length())throw new Failure("INVALID_REQUEST");c=text.charAt(at++);
                    if(c=='u'){if(at+4>text.length())throw new Failure("INVALID_REQUEST");int n=0;for(int i=0;i<4;i++){char hex=text.charAt(at++);if(!((hex>='0'&&hex<='9')||(hex>='a'&&hex<='f')||(hex>='A'&&hex<='F')))throw new Failure("INVALID_REQUEST");int h=Character.digit(hex,16);n=(n<<4)|h;}c=(char)n;}
                    else if(c=='b')c='\b';else if(c=='f')c='\f';else if(c=='n')c='\n';else if(c=='r')c='\r';else if(c=='t')c='\t';
                    else if(c!='"'&&c!='\\'&&c!='/')throw new Failure("INVALID_REQUEST");
                }
                result.append(c);if(result.length()>MAX_TEXT)throw new Failure("INVALID_REQUEST");
            }
            throw new Failure("INVALID_REQUEST");
        }
    }
    private static final class Json {
        final StringBuilder out=new StringBuilder();
        void append(String value)throws Failure{if(value.length()>MAX_OUTPUT-out.length())throw new Failure("OUTPUT_LIMIT");out.append(value);}
        void value(Object value)throws Failure{
            if(value==null){append("null");return;}if(value instanceof String){quote((String)value);return;}
            if(value instanceof Boolean||value instanceof Number){append(value.toString());return;}
            if(value instanceof Map<?,?>){append("{");boolean first=true;for(Map.Entry<?,?> entry:((Map<?,?>)value).entrySet()){if(!first)append(",");quote((String)entry.getKey());append(":");value(entry.getValue());first=false;}append("}");return;}
            throw new Failure("INVALID_RESULT");
        }
        void quote(String value)throws Failure{
            append("\"");for(int i=0;i<value.length();i++){char c=value.charAt(i);if(c=='\\')append("\\\\");else if(c=='"')append("\\\"");else if(c>=0x20&&c<=0x7e)append(Character.toString(c));else{String h=Integer.toHexString(c);append("\\u"+"0000".substring(h.length())+h);}}append("\"");
        }
        @Override public String toString(){return out.toString();}
    }
}
