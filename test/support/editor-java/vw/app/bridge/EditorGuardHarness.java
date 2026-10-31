package vw.app.bridge;

import android.graphics.Rect;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/** Synthetic host-side reflection harness. No Android or vehicle data. */
public final class EditorGuardHarness {
    public static final class FakeRange {
        final float current;
        FakeRange(float current) { this.current=current; }
        public int getType() { return 1; }
        public float getMin() { return 0f; }
        public float getMax() { return 229999f; }
        public float getCurrent() { return current; }
    }
    public static final class FakeNode {
        final String cls, id, text, description, state;
        final boolean visible, enabled, clickable, checkable, checked, selected;
        final int[] bounds;
        Object range;
        final List<FakeNode> children = new ArrayList<FakeNode>();
        FakeNode(String cls, String id, String text, String description, String state,
                 boolean visible, boolean enabled, boolean clickable, boolean checkable,
                 boolean checked, boolean selected, int[] bounds) {
            this.cls=cls; this.id=id; this.text=text; this.description=description; this.state=state;
            this.visible=visible; this.enabled=enabled; this.clickable=clickable;
            this.checkable=checkable; this.checked=checked; this.selected=selected; this.bounds=bounds;
        }
        public String getPackageName() { return "com.volkswagen.weconnect"; }
        public String getClassName() { return cls; }
        public String getViewIdResourceName() { return id; }
        public String getText() { return text; }
        public String getContentDescription() { return description; }
        public String getStateDescription() { return state; }
        public boolean isVisibleToUser() { return visible; }
        public boolean isEnabled() { return enabled; }
        public boolean isClickable() { return clickable; }
        public boolean isCheckable() { return checkable; }
        public boolean isChecked() { return checked; }
        public boolean isSelected() { return selected; }
        public Object getRangeInfo() { return range; }
        public int getChildCount() { return children.size(); }
        public FakeNode getChild(int n) { return children.get(n); }
        public void getBoundsInScreen(Rect rect) { rect.left=bounds[0]; rect.top=bounds[1]; rect.right=bounds[2]; rect.bottom=bounds[3]; }
        public void recycle() {}
    }
    static FakeNode make(String mode) {
        FakeNode root = new FakeNode("android.view.View",null,null,null,null,true,true,false,false,false,false,new int[]{0,0,1000,2000});
        root.children.add(new FakeNode("android.widget.Button",null,null,null,null,true,true,true,false,false,false,new int[]{mode.equals("geometry") ? 21 : 20,90,160,190}));
        root.children.add(new FakeNode("android.view.View",null,null,mode.equals("foreign") ? "Andere Ansicht" : "Zeit einstellen",null,true,true,false,false,false,false,new int[]{170,110,830,170}));
        FakeNode hour = new FakeNode("android.widget.SeekBar",null,null,"Hour",mode.equals("time") ? "09" : "08",true,true,true,false,false,false,new int[]{380,500,460,820});
        hour.range = new FakeRange(mode.equals("progress") ? 115002f : 115001f); if (!mode.equals("noWheels")) root.children.add(hour);
        FakeNode minute = new FakeNode("android.widget.SeekBar",null,null,"Minute",mode.equals("minute") ? "31" : "30",true,true,true,false,false,false,new int[]{580,500,660,820});
        minute.range = new FakeRange(60001f); if (!mode.equals("noWheels")) root.children.add(minute);
        String[] days={"MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"};
        for (int i=0; i<days.length; i++) root.children.add(new FakeNode("android.view.View","cta_"+days[i],null,null,null,
                true,true,true,false,false,mode.equals("day") && i==3,new int[]{40+i*135,900,160+i*135,1030}));
        String text = mode.equals("dirty") || mode.equals("dirtyHidden") ? "Speichern" : mode.equals("dirtyUpper") ? "SPEICHERN"
                : mode.equals("dirtyMixed") ? "Bitte sPeIcHeRn!" : mode.equals("dirtyEnglish") ? "Save changes" : null;
        String description = mode.equals("dirtyDescription") ? "Änderungen SPEICHERN, Schaltfläche" : null;
        String state = mode.equals("dirtyState") ? "Zum Speichern bereit" : null;
        String id = mode.equals("dirtyResource") ? "com.volkswagen.weconnect:id/vwd_save_button" : null;
        root.children.add(new FakeNode("android.widget.Switch",id,text,description,state,!mode.equals("dirtyHidden"),true,true,true,!mode.equals("repeat"),false,new int[]{800,1110,930,1230}));
        return root;
    }
    public static void main(String[] args) throws Exception {
        Class<?> cls=Class.forName("vw.app.bridge.AccessibilityActionRunner$Session");
        Constructor<?> constructor=cls.getDeclaredConstructor(); constructor.setAccessible(true);
        Object session=constructor.newInstance();
        Method verify=cls.getDeclaredMethod(args.length > 2 && "timer".equals(args[2]) ? "verifyTimerEditor" : "verifyCleanEditor",Object.class,String.class); verify.setAccessible(true);
        try { verify.invoke(session,make(args[1]),args[0]); System.out.print("OK"); }
        catch (InvocationTargetException ex) { System.out.print(ex.getCause().getMessage()); }
    }
}
