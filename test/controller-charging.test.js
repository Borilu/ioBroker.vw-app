'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../lib/controller');
const { BridgeError } = require('../lib/errors');
const { overviewChargingScreen, rangeScreen, chargingSettingsScreen, chargingFooterScreen, POINTS } = require('./support/charging-fixtures.cjs');
const { completeDemoClimate } = require('./support/settings-fixtures.cjs');
const { rangeModeScreen, chargingModeScreen, nativeObservationFromXml, MODE_POINTS } = require('./support/charging-mode-fixtures.cjs');
const VEHICLE = 'Ihr Fahrzeug: Testwagen. ';
const INITIAL = Object.freeze({socLimit:100,reducedAcCurrent:true,autoUnlockAc:false,optimizedBatteryUse:true});
const KEYS = Object.keys(INITIAL);
const clone = value => structuredClone(value);

function nativeSlider({ moved = false, mismatch = false } = {}) {
    const rowX = moved ? 65 : 50;
    const line = (indent, cls, box, id = '', flags = 'V.E......') => ' '.repeat(indent) + cls + '{abcd ' + flags + ' ........ '+box+(id?' #7f001001 app:id/'+id:'')+'}';
    return ['  ACTIVITY com.volkswagen.weconnect/.SingleActivity abcd pid=42',
        '      mResumed=true mStopped=false mFinished=false', '    View Hierarchy:', '      DecorView@abcd[SingleActivity]',
        line(8,'android.widget.LinearLayout','0,0-1000,1400'),
        line(10,'com.volkswagen.lib.ui.WindowCoordinatorLayout','0,0-1000,1400','container'),
        line(12,'androidx.recyclerview.widget.RecyclerView','0,100-1000,1400','recycler_view'),
        line(14,'androidx.cardview.widget.CardView',rowX+',280-'+(rowX+900)+',580'),
        line(16,'androidx.constraintlayout.widget.ConstraintLayout','0,20-900,270'),
        line(18,'androidx.appcompat.widget.AppCompatTextView',mismatch?'55,10-850,70':'50,10-850,70','subtitle'),
        line(18,'com.volkswagen.weconnect.resources.views.slider.GradientSlider','10,80-720,170','slider','VFED..C..'),
        line(18,'androidx.appcompat.widget.AppCompatTextView','750,100-870,160','value'),
        line(18,'androidx.appcompat.widget.AppCompatTextView','50,170-850,230','info')].join('\n');
}

class ChargingApp {
    constructor(options = {}) {
        this.page='overview';this.lower=false;this.footer=false;this.name='Testwagen';this.soc=52;this.rangeKm=205;
        this.saved=clone(INITIAL);this.draft=clone(INITIAL);this.dirty=false;
        this.calls=[];this.mutations=[];this.saves=0;this.syncs=0;this.chargingCtas=0;this.climateCtas=0;
        this.deadline=null;this.versionValue='4.8.1';this.syncBusy=false;
        Object.assign(this,options);
        if(options.saved) {this.saved=clone(options.saved);this.draft=clone(options.saved);}
    }
    async connect(){this.calls.push(['connect']);if(this.connectError)throw this.connectError;}
    async launch(){this.calls.push(['launch']);}
    async version(){if(this.beforeVersion)await this.beforeVersion();return this.versionValue;}
    async dump(){
        if(this.beforeDump)await this.beforeDump();
        if(this.page==='overview')return overviewChargingScreen({rangeKm:this.rangeKm,lower:this.lower}).replace('Ihr Fahrzeug: Testwagen.',this.wrongVehicle?'Ihr Fahrzeug: Anderes Auto.':'Ihr Fahrzeug: Testwagen.');
        if(this.page==='range') {
            if(this.mode !== undefined)return rangeModeScreen({mode:this.mode,enabled:!this.disabledMode,...(this.unreadableMode?{description:'Ladeverfahren. Unbekannt. Ladeverfahren ändern'}:{})});
            const view=rangeScreen({soc:this.soc,rangeKm:this.rangeKm});
            return this.missingDetailRange ? view.replace('Übersicht Reichweite. Batteriereichweite: '+this.rangeKm+' Kilometer','Unbekannte Reichweitenanzeige') : view;
        }
        if(this.page==='chargingMode')return chargingModeScreen({mode:this.mode});
        if(this.page==='climate')return completeDemoClimate();
        if(this.page==='vehicleSettings') {
            if(this.footer) {
                return chargingFooterScreen({busy:this.syncBusy});
            }
            return chargingSettingsScreen({...this.draft,vehicleName:this.name,dirty:this.dirty});
        }
        if(this.page==='blocked')return '<hierarchy><node package="com.volkswagen.weconnect" enabled="true" bounds="[0,0][1000,1400]" resource-id="alert_dialog"/></hierarchy>';
        throw new Error('Unknown fake page');
    }
    async nativeView(){this.calls.push(['native']);if(this.beforeNative)await this.beforeNative();return nativeSlider({mismatch:this.nativeMismatch});}
    async departureView(){
        if(this.beforeExtended)await this.beforeExtended();
        const xml=await this.dump();this.homeSnapshot=nativeObservationFromXml(xml);
        return {xml:'UNRELATED CACHE MUST NOT BE USED',observation:this.homeSnapshot};
    }
    async departureAction(request){
        assert.equal(request.snapshot,this.homeSnapshot);
        if(request.action==='click'){
            assert.equal(this.page,'chargingMode');assert.equal(request.header,'Ladeverfahren');
            assert.deepEqual(request.target,{id:'chargeModeSelectionBack',class:'android.view.View',bounds:[20,0,120,100]});
            this.calls.push(['modeNativeBack']);this.modeBackNativeCalls=(this.modeBackNativeCalls||0)+1;
            if(this.failModeBack)throw new Error('SECRET lost native header response');
            if(!this.ignoreModeBack)this.page='range';
            const xml=await this.dump();
            return this.modeBackResult||{beforeMatched:true,actionAttempted:true,actionAccepted:true,success:true,errorCode:null,
                postRead:{xml:'STALE CACHE MUST NOT BE USED',observation:nativeObservationFromXml(xml)}};
        }
        assert.equal(request.action,'scrollBackward');
        assert.equal(request.header,'Ihr Fahrzeug: Testwagen. Gerade synchronisiert');
        assert.deepEqual(request.target,{class:'android.widget.ScrollView',bounds:[20,100,980,1300]});
        this.calls.push(['homeNativeAction','scrollBackward']);this.lower=false;
        const xml=await this.dump();
        return {beforeMatched:true,actionAttempted:true,actionAccepted:true,success:true,errorCode:null,postRead:{xml,observation:nativeObservationFromXml(xml)}};
    }
    async swipe(gesture){
        this.calls.push(['swipe',this.page,clone(gesture)]);
        if(this.page==='overview'){this.lower=gesture.y2<gesture.y1;return;}
        if(this.page==='vehicleSettings'){this.footer=gesture.y2<gesture.y1;return;}
        throw new Error('Unexpected fake swipe');
    }
    async back(){this.calls.push(['back',this.page]);if(this.page==='climate')this.page='overview';else throw new Error('Unexpected Android Back');}
    async change(key,value){
        this.draft[key]=value;this.dirty=KEYS.some(k=>this.saved[k]!==this.draft[k]);this.mutations.push([key,value]);
        if(this.afterChange)await this.afterChange(key,value);
    }
    async tap(x,y){
        this.calls.push(['tap',this.page,x,y]);
        if(this.page==='overview'){
            if(x===POINTS.range.x){if(this.lower)throw new Error('Tap intercepted by sticky header');this.page='range';return;}
            if(x===POINTS.vehicleSettings.x&&y===POINTS.vehicleSettings.y&&this.lower){this.page='vehicleSettings';this.footer=false;this.draft=clone(this.saved);this.dirty=false;return;}
        }
        if(this.page==='range'){
            if(this.mode!==undefined&&x===MODE_POINTS.open.x&&y===MODE_POINTS.open.y){this.page='chargingMode';return;}
            if(x===POINTS.back.x&&y===POINTS.back.y){this.page='overview';return;}
            this.chargingCtas++;throw new Error('Charging CTA must never be touched');
        }
        if(this.page==='chargingMode'){
            assert.notDeepEqual({x,y},MODE_POINTS.back,'Picker return must use its native accessibility action');
            const choice=Object.keys(MODE_POINTS).find(key=>!['open','back'].includes(key)&&MODE_POINTS[key].x===x&&MODE_POINTS[key].y===y);
            assert.ok(choice,'Only a bound semantic mode card may be touched');
            this.modeTaps=(this.modeTaps||0)+1;
            if(!this.ignoreMode)this.mode=choice;
            if(this.afterMode)await this.afterMode(choice);
            return;
        }
        if(this.page==='vehicleSettings'){
            if(x===POINTS.vehicleSettingsBack.x&&y===POINTS.vehicleSettingsBack.y){if(this.dirty)throw new Error('Unsaved data discarded');this.page='overview';return;}
            if(x===POINTS.saveCharging.x&&y===POINTS.saveCharging.y){
                this.saves++;if(this.failSave)throw new Error('SECRET lost Save response');
                if(this.holdSave)return;
                if(!this.dropSave)this.saved=clone(this.draft);
                this.dirty=false;this.page='overview';return;
            }
            if(this.footer&&x===POINTS.synchronize.x&&y===POINTS.synchronize.y){
                this.syncs++;if(this.failSync)throw new Error('SECRET sync transport');
                if(!this.ignoreSync)this.syncBusy=true;return;
            }
            if(!this.footer&&y===525&&x>=60&&x<770){
                await this.change('socLimit',50+Math.round(((x-60)/710)*5)*10);return;
            }
            for(const key of ['reducedAcCurrent','autoUnlockAc','optimizedBatteryUse'])if(x===POINTS[key].x&&y===POINTS[key].y){await this.change(key,!this.draft[key]);return;}
        }
        this.climateCtas++;throw new Error('Unexpected fake target '+JSON.stringify([this.page,x,y]));
    }
}
function setup(options={},config={}){
    const phone=new ChargingApp(options),clock={value:1700000000000};
    const store={reservations:0,async reserveCommand(){this.reservations++;}};
    const controller=new Controller({phone,store,config:{approvedAppVersion:'4.8.1',vehicleMarker:{contentDescPrefix:VEHICLE},modeTitles:['Klimatisierung'],allowWrites:true,commandTimeoutSeconds:300,outcomeTimeoutSeconds:120,cooldownSeconds:60,...config},
        now:()=>clock.value,sleep:async ms=>{clock.value+=ms;}});
    return {phone,controller,store,clock};
}
async function rejects(promise,code){await assert.rejects(promise,e=>e instanceof BridgeError&&e.code===code&&!e.message.includes('SECRET'));}
function noCtas(phone,store){assert.equal(phone.chargingCtas,0);assert.equal(phone.climateCtas,0);assert.equal(store.reservations,0);}

test('charging status reads SOC, unit-confirmed range and four saved preferences without a Save or vehicle CTA',async()=>{
    const {controller,phone,store}=setup();const result=await controller.execute('chargingStatus');
    assert.equal(result.domain,'charging');assert.deepEqual(result.battery,{soc:52,rangeKm:205});assert.deepEqual(result.charging,{...INITIAL,mode:null});
    assert.equal(result.vehicleConfirmed,false);assert.equal(Object.hasOwn(result,'appState'),false);assert.equal(result.changed,false);
    assert.equal(phone.page,'overview');assert.equal(phone.lower,false);assert.equal(phone.saves,0);assert.equal(phone.syncs,0);assert.deepEqual(phone.mutations,[]);noCtas(phone,store);
});

test('SOC zero and zero remaining kilometers remain real observations instead of missing data',async()=>{
    const {controller}=setup({soc:0,rangeKm:0});const result=await controller.execute('chargingStatus');
    assert.deepEqual(result.battery,{soc:0,rangeKm:0});
});

test('a four-preference job saves once, reopens the settings and leaves the vehicle name unchanged',async()=>{
    const {controller,phone,store}=setup();const wanted={socLimit:80,reducedAcCurrent:false,autoUnlockAc:true,optimizedBatteryUse:false};
    const result=await controller.execute('applyChargingSettings',{targetCharging:wanted});
    assert.deepEqual(result.charging,{...wanted,mode:null});assert.deepEqual(phone.saved,wanted);assert.equal(result.changed,true);
    assert.equal(phone.saves,1);assert.equal(phone.name,'Testwagen');assert.deepEqual(phone.mutations,[['socLimit',80],['reducedAcCurrent',false],['autoUnlockAc',true],['optimizedBatteryUse',false]]);noCtas(phone,store);
});

test('all six target SOC positions are confirmed from the fresh native view and survive page reopening',async()=>{
    for(const limit of [50,60,70,80,90,100]){
        const {controller,phone,store}=setup({saved:{...INITIAL,socLimit:limit===100?50:100}});
        const result=await controller.execute('applyChargingSettings',{targetCharging:{socLimit:limit}});
        assert.equal(result.charging.socLimit,limit);assert.equal(phone.saved.socLimit,limit);assert.equal(phone.saves,1);noCtas(phone,store);
    }
});

test('an already-satisfied selection does not touch a switch, slider, Save or vehicle CTA',async()=>{
    const {controller,phone,store}=setup();const result=await controller.execute('applyChargingSettings',{targetCharging:INITIAL});
    assert.equal(result.changed,false);assert.deepEqual(phone.mutations,[]);assert.equal(phone.saves,0);assert.ok(!phone.calls.some(call=>call[0]==='native'));noCtas(phone,store);
});

test('unsupported SOC values are rejected before connecting or moving the app',async()=>{
    for(const socLimit of [49,51,55,75,101,'80',true,NaN]){
        const {controller,phone}=setup();await rejects(controller.execute('applyChargingSettings',{targetCharging:{socLimit}}),'invalid_charging_settings');assert.deepEqual(phone.calls,[]);
    }
    const empty=setup();await rejects(empty.controller.execute('applyChargingSettings'),'charging_settings_required');assert.deepEqual(empty.phone.calls,[]);
});

test('read-only mode permits observations and dry-run preflight but no setting changes',async()=>{
    const first=setup({}, {allowWrites:false});await rejects(first.controller.execute('applyChargingSettings',{targetCharging:{socLimit:80}}),'writes_disabled');assert.deepEqual(first.phone.mutations,[]);
    const dry=setup({}, {allowWrites:false});const result=await dry.controller.execute('applyChargingSettings',{dryRun:true,targetCharging:{socLimit:80,autoUnlockAc:true}});
    assert.equal(result.dryRun,true);assert.equal(result.wouldSetCharging.socLimit,80);assert.deepEqual(dry.phone.mutations,[]);assert.equal(dry.phone.saves,0);
});

test('wrong vehicle or app version prevents setting edits and Save',async()=>{
    for(const [options,code] of [[{wrongVehicle:true},'wrong_vehicle'],[{versionValue:'OTHER'},'version_not_approved']]){
        const {controller,phone}=setup(options);await rejects(controller.execute('applyChargingSettings',{targetCharging:{socLimit:80}}),code);assert.deepEqual(phone.mutations,[]);assert.equal(phone.saves,0);
    }
});

test('a preexisting manual charging draft is not hidden, saved or discarded',async()=>{
    const {controller,phone}=setup({page:'vehicleSettings',dirty:true});await rejects(controller.execute('chargingStatus'),'unsaved_settings');
    assert.equal(phone.page,'vehicleSettings');assert.equal(phone.saves,0);assert.ok(!phone.calls.some(call=>call[0]==='tap'||call[0]==='swipe'));assert.deepEqual(phone.mutations,[]);
});

test('native hierarchy disagreement blocks every requested edit during complete preflight',async()=>{
    const {controller,phone}=setup({nativeMismatch:true});await rejects(controller.execute('applyChargingSettings',{targetCharging:{socLimit:80,reducedAcCurrent:false}}),'charging_slider_unavailable');
    assert.deepEqual(phone.mutations,[]);assert.equal(phone.saves,0);
});

test('changing the vehicle name during a version check prevents saving unrelated form data',async()=>{
    const {controller,phone}=setup();phone.beforeVersion=()=>{if(phone.page==='vehicleSettings')phone.name='SECRET_CHANGED_NAME';};
    await rejects(controller.execute('applyChargingSettings',{targetCharging:{reducedAcCurrent:false}}),'charging_state_changed');assert.deepEqual(phone.mutations,[]);assert.equal(phone.saves,0);
});

test('an unrelated option changed during native preflight prevents the following slider tap and Save',async()=>{
    const {controller,phone}=setup();let reads=0;phone.beforeNative=()=>{if(++reads===2)phone.draft.autoUnlockAc=true;};
    await rejects(controller.execute('applyChargingSettings',{targetCharging:{socLimit:80}}),'charging_state_changed');assert.deepEqual(phone.mutations,[]);assert.equal(phone.saves,0);
});

test('a lost draft-toggle response is never followed by Save or an automatic repeat',async()=>{
    const {controller,phone}=setup();phone.afterChange=()=>{throw new Error('SECRET transport');};
    await rejects(controller.execute('applyChargingSettings',{targetCharging:{reducedAcCurrent:false}}),'charging_outcome_unknown');assert.equal(phone.mutations.length,1);assert.equal(phone.saves,0);
});

test('a lost Save response remains unknown and Save is attempted once',async()=>{
    const {controller,phone,store}=setup({failSave:true});await rejects(controller.execute('applyChargingSettings',{targetCharging:{socLimit:80}}),'charging_outcome_unknown');assert.equal(phone.saves,1);noCtas(phone,store);
});

test('Save without completion is bounded and never repeated',async()=>{
    const {controller,phone}=setup({holdSave:true});await rejects(controller.execute('applyChargingSettings',{targetCharging:{socLimit:80}}),'charging_outcome_unknown');assert.equal(phone.saves,1);
});

test('an optimistic value that disappears after reopening is not reported as saved',async()=>{
    const {controller,phone}=setup({dropSave:true});await rejects(controller.execute('applyChargingSettings',{targetCharging:{socLimit:80}}),'charging_outcome_unknown');assert.equal(phone.saved.socLimit,100);assert.equal(phone.saves,1);
});

test('a synchronization request is sent once without write permission, preference changes, Save or a vehicle CTA',async()=>{
    const {controller,phone,store}=setup({}, {allowWrites:false});const result=await controller.execute('synchronize');
    assert.equal(result.syncRequested,true);assert.equal(typeof result.syncRequestedAt,'string');assert.ok(Number.isFinite(Date.parse(result.syncRequestedAt)));
    assert.equal(result.vehicleConfirmed,false);assert.equal(phone.syncs,1);assert.equal(phone.saves,0);assert.deepEqual(phone.mutations,[]);noCtas(phone,store);
});

test('an already busy synchronization link receives no repeated request',async()=>{
    const {controller,phone}=setup({syncBusy:true});await rejects(controller.execute('synchronize'),'sync_busy');assert.equal(phone.syncs,0);assert.equal(phone.saves,0);
});

test('a synchronization dry run reads current values without sending a request',async()=>{
    const {controller,phone}=setup();const result=await controller.execute('synchronize',{dryRun:true});
    assert.equal(result.dryRun,true);assert.equal(result.syncRequested,undefined);assert.equal(phone.syncs,0);assert.equal(phone.saves,0);
});

test('missing synchronization acknowledgment is bounded and never retried',async()=>{
    const {controller,phone}=setup({ignoreSync:true});await rejects(controller.execute('synchronize'),'sync_outcome_unknown');assert.equal(phone.syncs,1);
});

test('unknown transport outcome after sync cannot create a second tap',async()=>{
    const {controller,phone}=setup({failSync:true});await rejects(controller.execute('synchronize'),'sync_outcome_unknown');assert.equal(phone.syncs,1);
});

test('normal status never presses synchronization and safely returns from an existing range sheet',async()=>{
    const {controller,phone}=setup({page:'range'});const result=await controller.execute('chargingStatus');assert.equal(result.battery.soc,52);assert.equal(phone.syncs,0);assert.equal(phone.page,'overview');
});

test('the scoped overview range is used if only SOC is readable in the detail sheet',async()=>{
    const {controller}=setup({missingDetailRange:true});
    assert.deepEqual((await controller.execute('chargingStatus')).battery,{soc:52,rangeKm:205});
});

test('a matching manual draft arriving before the first own edit is never saved',async()=>{
    const {controller,phone}=setup();
    phone.beforeVersion=()=>{if(phone.page==='vehicleSettings'){phone.draft.reducedAcCurrent=false;phone.dirty=true;}};
    await rejects(controller.execute('applyChargingSettings',{targetCharging:{reducedAcCurrent:false}}),'unsaved_settings');
    assert.equal(phone.saves,0);assert.deepEqual(phone.mutations,[]);assert.deepEqual(phone.saved,INITIAL);
});

test('busy reservation is synchronous and cancellation prevents subsequent UI edits',async()=>{
    const {controller,phone}=setup();let release;const gate=new Promise(resolve=>{release=resolve;});phone.connect=async()=>gate;
    const active=controller.execute('chargingStatus');await rejects(controller.execute('chargingStatus'),'busy');controller.cancel();release();await rejects(active,'cancelled');assert.deepEqual(phone.mutations,[]);assert.equal(phone.deadline,null);assert.equal(controller.busy,false);
});

test('accepted target snapshots are unaffected by later caller mutation',async()=>{
    const {controller,phone}=setup();const target={socLimit:80};phone.beforeVersion=()=>{target.socLimit=50;};
    const result=await controller.execute('applyChargingSettings',{targetCharging:target});assert.equal(result.charging.socLimit,80);assert.equal(phone.saved.socLimit,80);
});

test('charging status reads the native mode and its own snapshot time without any setting or journal action',async()=>{
    const {controller,phone,store,clock}=setup({mode:'departureClimate'});
    phone.beforeExtended=()=>{clock.value+=5;};
    const result=await controller.execute('chargingStatus');
    assert.equal(result.charging.mode,'departureClimate');
    assert.equal(result.modeObservedAt,result.observedAt);
    assert.equal(result.changed,false);assert.equal(result.vehicleConfirmed,false);
    assert.equal(phone.modeTaps||0,0);assert.equal(phone.saves,0);assert.equal(phone.syncs,0);
    noCtas(phone,store);assert.equal(phone.page,'overview');
});

test('each mode is applied by one semantic selection with one prior reservation and no other setting writes',async()=>{
    for(const mode of ['immediate','departure','departureClimate']){
        const {controller,phone,store}=setup({mode:mode==='departure'?'immediate':'departure'});
        phone.afterMode=()=>{assert.equal(store.reservations,1,'journal is durable before the effective selection');};
        const result=await controller.execute('applyChargingMode',{targetChargingMode:mode});
        assert.equal(result.charging.mode,mode);assert.equal(result.changed,true);
        assert.equal(phone.modeTaps,1);assert.equal(store.reservations,1);
        assert.equal(phone.saves,0);assert.equal(phone.syncs,0);assert.deepEqual(phone.mutations,[]);
        assert.deepEqual(phone.saved,INITIAL);assert.equal(phone.page,'overview');
        assert.equal(phone.chargingCtas+phone.climateCtas,0);assert.equal(phone.calls.filter(c=>c[0]==='connect').length,1);
        assert.equal(controller.busy,false);assert.equal(phone.deadline,null);
    }
});

test('same-mode and dry-run selections never reserve cooldown or select a mode',async()=>{
    const same=setup({mode:'departure'},{allowWrites:false});
    same.store.reserveCommand=async()=>assert.fail('An already fulfilled read does not reserve a vehicle action');
    const first=await same.controller.execute('applyChargingMode',{targetChargingMode:'departure'});
    assert.equal(first.changed,false);assert.equal(same.phone.modeTaps||0,0);
    assert.ok(!same.phone.calls.some(c=>c[0]==='tap'&&c[1]==='chargingMode'));
    const dry=setup({mode:'departure'},{allowWrites:false});
    const second=await dry.controller.execute('applyChargingMode',{targetChargingMode:'immediate',dryRun:true});
    assert.equal(second.wouldSetChargingMode,'immediate');assert.equal(second.changed,false);
    assert.equal(second.charging.mode,'departure');assert.equal(dry.phone.modeTaps||0,0);
    assert.equal(dry.phone.page,'overview');noCtas(dry.phone,dry.store);
});

test('a changing mode needs permission and a valid wish before any effective selection',async()=>{
    const f=setup({mode:'departure'},{allowWrites:false});
    await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),'writes_disabled');
    assert.equal(f.phone.modeTaps||0,0);assert.equal(f.store.reservations,0);
    for(const [value,code] of [[null,'charging_mode_required'],[undefined,'charging_mode_required'],['UNKNOWN','invalid_charging_mode']]){
        const invalid=setup({mode:'departure'});
        await rejects(invalid.controller.execute('applyChargingMode',{targetChargingMode:value}),code);
        assert.deepEqual(invalid.phone.calls,[]);
    }
});

test('cooldown or journal persistence failures prevent the one mode tap',async()=>{
    for(const code of ['cooldown','state_not_saved']){
        const f=setup({mode:'departure'});
        f.store.reserveCommand=async()=>{f.store.reservations++;throw new BridgeError(code,'Synthetic reservation failure.');};
        await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),code);
        assert.equal(f.phone.modeTaps||0,0);assert.equal(f.store.reservations,1);
        assert.equal(f.phone.saves,0);assert.equal(f.phone.calls.filter(c=>c[0]==='connect').length,1);
    }
});

test('a lost mode-tap response is unknown and can never produce another selection or reconnect',async()=>{
    const f=setup({mode:'departure'});
    f.phone.afterMode=()=>{throw new BridgeError('foreign_private','SECRET lost mode response');};
    await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),'charging_mode_outcome_unknown');
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);
    assert.equal(f.phone.calls.filter(c=>c[0]==='connect').length,1);
    assert.equal(f.phone.saves+f.phone.syncs+f.phone.chargingCtas+f.phone.climateCtas,0);
    assert.equal(f.controller.busy,false);assert.equal(f.phone.deadline,null);
});

test('missing confirmation is bounded and does not repeat a mode selection',async()=>{
    const f=setup({mode:'departure',ignoreMode:true},{outcomeTimeoutSeconds:2});
    await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),'charging_mode_outcome_unknown');
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);
    assert.equal(f.phone.calls.filter(c=>c[0]==='connect').length,1);
});

test('native read failure after the effective selection cannot fall back or retry',async()=>{
    const f=setup({mode:'departure'});
    f.phone.afterMode=()=>{f.phone.departureView=async()=>({xml:rangeModeScreen({mode:'immediate'}),observation:{}});};
    await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),'charging_mode_outcome_unknown');
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);
});

test('an unreadable mode still permits battery observations but blocks mode apply before selection',async()=>{
    const read=setup({mode:'departure',unreadableMode:true});
    const result=await read.controller.execute('chargingStatus');
    assert.deepEqual(result.battery,{soc:52,rangeKm:205});
    assert.equal(result.charging.mode,null);assert.equal(result.modeObservedAt,null);noCtas(read.phone,read.store);
    const write=setup({mode:'departure',unreadableMode:true});
    await rejects(write.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),'charging_mode_unavailable');
    assert.equal(write.phone.modeTaps||0,0);assert.equal(write.store.reservations,0);
});

test('a disabled mode remains a timestamped observation but cannot open the selector',async()=>{
    const read=setup({mode:'departure',disabledMode:true});
    const result=await read.controller.execute('chargingStatus');
    assert.equal(result.charging.mode,'departure');assert.equal(result.modeObservedAt,result.observedAt);
    assert.equal(result.changed,false);assert.equal(read.phone.modeTaps||0,0);noCtas(read.phone,read.store);
    const same=setup({mode:'departure',disabledMode:true});
    const unchanged=await same.controller.execute('applyChargingMode',{targetChargingMode:'departure'});
    assert.equal(unchanged.charging.mode,'departure');assert.equal(unchanged.changed,false);
    assert.ok(!same.phone.calls.some(c=>c[0]==='tap'&&c[1]==='range'&&c[2]===MODE_POINTS.open.x&&c[3]===MODE_POINTS.open.y));
    assert.equal(same.phone.modeTaps||0,0);noCtas(same.phone,same.store);
    for(const dryRun of [false,true]){
        const write=setup({mode:'departure',disabledMode:true});
        await rejects(write.controller.execute('applyChargingMode',{targetChargingMode:'immediate',dryRun}),'target_unavailable');
        assert.equal(write.phone.modeTaps||0,0);assert.equal(write.store.reservations,0);
        assert.ok(!write.phone.calls.some(c=>c[0]==='tap'&&c[1]==='range'&&c[2]===MODE_POINTS.open.x&&c[3]===MODE_POINTS.open.y));
        noCtas(write.phone,write.store);
    }
});

test('vehicle or approved-version mismatches prevent a mode selection and reservation',async()=>{
    for(const [options,code] of [[{wrongVehicle:true},'wrong_vehicle'],[{versionValue:'OTHER'},'version_not_approved']]){
        const f=setup({mode:'departure',...options});
        await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),code);
        assert.equal(f.phone.modeTaps||0,0);assert.equal(f.store.reservations,0);
    }
});

test('mode apply snapshots only its own primitive wish and never reads unrelated setting getters',async()=>{
    const f=setup({mode:'departure'});
    const options={targetChargingMode:'departureClimate'};
    for(const key of ['targetCharging','targetSettings','targetTemperature'])Object.defineProperty(options,key,{get(){return assert.fail('Unrelated wish read');}});
    f.phone.beforeVersion=()=>{options.targetChargingMode='immediate';};
    const result=await f.controller.execute('applyChargingMode',options);
    assert.equal(result.charging.mode,'departureClimate');assert.equal(f.phone.modeTaps,1);
    assert.deepEqual(f.phone.saved,INITIAL);
});

test('a human mode change during cooldown persistence prevents the subsequent selection',async()=>{
    const f=setup({mode:'departure'});
    f.store.reserveCommand=async()=>{f.store.reservations++;f.phone.mode='immediate';};
    await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'}),'charging_state_changed');
    assert.equal(f.store.reservations,1);assert.equal(f.phone.modeTaps||0,0);
});

test('fresh native recovery ignores a stale standard range underneath an open charging-mode picker',async()=>{
    const f=setup({mode:'departure',page:'chargingMode'});
    const actual=f.phone.dump.bind(f.phone);
    f.phone.departureView=async()=>{
        f.phone.homeSnapshot=nativeObservationFromXml(await actual());
        return {xml:rangeScreen(),observation:f.phone.homeSnapshot};
    };
    f.phone.dump=async()=>f.phone.page==='chargingMode'?rangeScreen():actual();
    const result=await f.controller.execute('chargingStatus');
    assert.equal(result.charging.mode,'departure');assert.equal(f.phone.modeTaps||0,0);
    assert.equal(f.phone.modeBackNativeCalls,1);
    assert.ok(f.phone.calls.findIndex(c=>c[0]==='modeNativeBack')<f.phone.calls.findIndex(c=>c[0]==='tap'));
    assert.ok(!f.phone.calls.some(c=>c[0]==='tap'&&c[1]==='chargingMode'));
    assert.equal(f.phone.page,'overview');noCtas(f.phone,f.store);
});

test('unclear native picker return never falls back to a pointer or a second accessibility action',async()=>{
    for(const options of [{modeBackResult:{beforeMatched:true,actionAttempted:true,actionAccepted:null,success:false,errorCode:null}},
        {failModeBack:true},{ignoreModeBack:true}]){
        const f=setup({mode:'departure',page:'chargingMode',...options});
        await rejects(f.controller.execute('chargingStatus'),options.failModeBack?'internal_error':options.ignoreModeBack?'unexpected_screen':'charging_navigation_unavailable');
        assert.equal(f.phone.modeBackNativeCalls,1);assert.equal(f.phone.modeTaps||0,0);
        assert.ok(!f.phone.calls.some(c=>c[0]==='tap'));noCtas(f.phone,f.store);
    }
});

test('picker return after a real mode selection requires one confirmed native action and otherwise keeps the outcome unknown',async()=>{
    const f=setup({mode:'departure',failModeBack:true});
    await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'immediate'}),'charging_mode_outcome_unknown');
    assert.equal(f.phone.modeTaps,1);assert.equal(f.phone.modeBackNativeCalls,1);
    assert.equal(f.store.reservations,1);assert.equal(f.phone.calls.filter(c=>c[0]==='connect').length,1);
});

test('a visible mode picker cannot be dismissed when native action capability is missing',async()=>{
    const f=setup({mode:'departure',page:'chargingMode'});
    f.phone.departureAction=undefined;
    await rejects(f.controller.execute('chargingStatus'),'extended_ui_unavailable');
    assert.ok(!f.phone.calls.some(c=>c[0]==='tap'));assert.equal(f.phone.modeTaps||0,0);
    noCtas(f.phone,f.store);
});

test('a mode confirmation after twenty seconds uses the configured outcome window without another selection',async()=>{
    const f=setup({mode:'departure',ignoreMode:true},{outcomeTimeoutSeconds:120});
    let tappedAt;
    f.phone.afterMode=()=>{tappedAt=f.clock.value;};
    f.phone.beforeExtended=()=>{if(tappedAt!==undefined&&f.clock.value-tappedAt>=25000)f.phone.mode='departureClimate';};
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
    assert.equal(result.charging.mode,'departureClimate');assert.equal(result.changed,true);
    assert.ok(f.clock.value-tappedAt>=25000&&f.clock.value-tappedAt<120000);
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);
    assert.equal(f.phone.calls.filter(c=>c[0]==='connect').length,1);
    assert.equal(f.phone.saves+f.phone.syncs+f.phone.chargingCtas+f.phone.climateCtas,0);
});

test('transitional selected-state snapshots are reread without a second mode gesture',async()=>{
    const f=setup({mode:'departure'});const original=f.phone.departureView.bind(f.phone);let transitional=0;
    f.phone.departureView=async()=>{
        const view=await original();
        if(f.phone.modeTaps&&f.phone.page==='chargingMode'&&transitional++<2){
            return {observation:nativeObservationFromXml(chargingModeScreen({mode:f.phone.mode}).replace('state-description="Ausgewählt"','state-description=""'))};
        }
        return view;
    };
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
    assert.equal(result.charging.mode,'departureClimate');assert.ok(transitional>=2);
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);assert.equal(f.phone.modeBackNativeCalls,1);
});

test('an automatic return to the bound vehicle Home is followed only by a range read',async()=>{
    const f=setup({mode:'departure'});
    f.phone.afterMode=()=>{f.phone.page='overview';};
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
    assert.equal(result.charging.mode,'departureClimate');assert.equal(f.phone.page,'overview');
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);assert.equal(f.phone.modeBackNativeCalls||0,0);
    assert.equal(f.phone.calls.filter(c=>c[0]==='tap'&&c[1]==='overview'&&c[2]===POINTS.range.x).length,2);
    assert.equal(f.phone.saves+f.phone.syncs+f.phone.chargingCtas+f.phone.climateCtas,0);
});

test('one successful native header return tolerates its still-visible picker snapshot using reads only',async()=>{
    const f=setup({mode:'departure'});const original=f.phone.departureAction.bind(f.phone);
    f.phone.departureAction=async request=>{
        const result=await original(request);
        return request.action==='click'?{...result,postRead:{observation:nativeObservationFromXml(chargingModeScreen({mode:f.phone.mode}))}}:result;
    };
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
    assert.equal(result.charging.mode,'departureClimate');assert.equal(f.phone.page,'overview');
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);assert.equal(f.phone.modeBackNativeCalls,1);
    assert.ok(!f.phone.calls.some(c=>c[0]==='tap'&&c[1]==='chargingMode'&&c[2]===MODE_POINTS.back.x));
});

test('a successful native header return may reach bound Home before the range confirmation',async()=>{
    const f=setup({mode:'departure'});const original=f.phone.departureAction.bind(f.phone);
    f.phone.departureAction=async request=>{
        const result=await original(request);
        if(request.action!=='click')return result;
        f.phone.page='overview';
        return {...result,postRead:{observation:nativeObservationFromXml(await f.phone.dump())}};
    };
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
    assert.equal(result.charging.mode,'departureClimate');assert.equal(f.phone.modeBackNativeCalls,1);
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);
});

test('wrong vehicle, changed version or foreign foreground after a selection stops confirmation immediately',async()=>{
    for(const failure of ['vehicle','version','foreground']){
        const f=setup({mode:'departure'});let rejectedReads=0;
        f.phone.afterMode=()=>{
            if(failure==='vehicle'){f.phone.page='overview';f.phone.wrongVehicle=true;}
            if(failure==='version')f.phone.versionValue='OTHER';
            if(failure==='foreground')f.phone.departureView=async()=>{rejectedReads++;throw new BridgeError('phone_locked_or_other_app','Synthetic foreground changed.');};
        };
        await rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'}),'charging_mode_outcome_unknown');
        assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);assert.equal(f.phone.modeBackNativeCalls||0,0);
        assert.equal(f.phone.calls.filter(c=>c[0]==='tap'&&c[1]==='overview'&&c[2]===POINTS.range.x).length,1);
        if(failure==='foreground')assert.equal(rejectedReads,1);
        assert.equal(f.phone.calls.filter(c=>c[0]==='connect').length,1);
    }
});

test('a transition after stable picker confirmation sends no header action when Range or Home is already visible',async()=>{
    for(const destination of ['range','overview']){
        const f=setup({mode:'departure'});let pickerReads=0;
        f.phone.beforeExtended=()=>{
            if(f.phone.modeTaps&&f.phone.page==='chargingMode'&&++pickerReads===3){
                f.phone.page=destination;
                if(destination==='overview')f.phone.lower=true;
            }
        };
        const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
        assert.equal(result.charging.mode,'departureClimate');assert.equal(f.phone.modeTaps,1);
        assert.equal(f.store.reservations,1);assert.equal(f.phone.modeBackNativeCalls||0,0);
        assert.equal(f.phone.page,'overview');
    }
});

test('a transitional snapshot just before the header action is reread before one bound click',async()=>{
    const f=setup({mode:'departure'});const original=f.phone.departureView.bind(f.phone);let reads=0;
    f.phone.departureView=async()=>{
        const view=await original();
        if(f.phone.modeTaps&&f.phone.page==='chargingMode'&&++reads===3){
            return {observation:nativeObservationFromXml(chargingModeScreen({mode:f.phone.mode}).replace('state-description="Ausgewählt"','state-description=""'))};
        }
        return view;
    };
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
    assert.equal(result.charging.mode,'departureClimate');assert.equal(f.phone.modeBackNativeCalls,1);
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);assert.ok(reads>=4);
});

test('a validated transition after opening Range is reread without repeating its navigation tap',async()=>{
    const f=setup({mode:'departure'});const original=f.phone.departureView.bind(f.phone);let transient=false;
    f.phone.departureView=async()=>{
        const view=await original();
        if(f.phone.page==='range'&&!transient){
            transient=true;
            return {observation:nativeObservationFromXml(chargingModeScreen().replace('content-desc="Ladeverfahren"','content-desc="Zwischenansicht"'))};
        }
        return view;
    };
    const result=await f.controller.execute('chargingStatus');
    assert.equal(result.charging.mode,'departure');assert.equal(transient,true);
    assert.equal(f.phone.calls.filter(c=>c[0]==='tap'&&c[1]==='overview'&&c[2]===POINTS.range.x).length,1);
    assert.equal(f.phone.modeTaps||0,0);noCtas(f.phone,f.store);
});

test('a wrong vehicle in the immediate header postRead cannot be hidden by a later correct Home frame',async()=>{
    const f=setup({mode:'departure'});const originalAction=f.phone.departureAction.bind(f.phone),originalRead=f.phone.departureView.bind(f.phone);
    let wrongPostReadSent=false,readsAfterWrongPostRead=0;
    f.phone.departureView=async()=>{if(wrongPostReadSent)readsAfterWrongPostRead++;return originalRead();};
    f.phone.departureAction=async request=>{
        const result=await originalAction(request);
        if(request.action!=='click')return result;
        f.phone.page='overview';wrongPostReadSent=true;
        return {...result,postRead:{observation:nativeObservationFromXml(overviewChargingScreen().replace('Ihr Fahrzeug: Testwagen.','Ihr Fahrzeug: Anderes Auto.'))}};
    };
    await assert.rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'}),error=>
        error.code==='charging_mode_outcome_unknown'&&error.message.includes('Ursache: wrong_vehicle.'));
    assert.equal(readsAfterWrongPostRead,0);assert.equal(f.phone.modeTaps,1);assert.equal(f.phone.modeBackNativeCalls,1);
    assert.equal(f.store.reservations,1);
});

test('an already completed final Home return does not cause another Range-close gesture',async()=>{
    const f=setup({mode:'departure'});let rangeReadsAfterHeader=0;
    f.phone.beforeExtended=()=>{
        if(f.phone.modeBackNativeCalls===1&&f.phone.page==='range'&&++rangeReadsAfterHeader===2)f.phone.page='overview';
    };
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'});
    assert.equal(result.charging.mode,'departureClimate');assert.equal(f.phone.page,'overview');
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);assert.equal(f.phone.modeBackNativeCalls,1);
    assert.equal(f.phone.calls.filter(c=>c[0]==='tap'&&c[1]==='range'&&c[2]===POINTS.back.x&&c[3]===POINTS.back.y).length,0);
});

test('unknown mode feedback includes only an allowed own cause code and never reads foreign getters or raw messages',async()=>{
    let getterCalls=0;
    for(const [foreign,cause] of [[new BridgeError('unknown_state','SECRET RAW MESSAGE'),'unknown_state'],
        [new BridgeError('PRIVATE_CODE','SECRET RAW MESSAGE'),'unclassified'],
        [Object.defineProperty({message:'SECRET RAW MESSAGE'},'code',{get(){getterCalls++;return 'unknown_state';}}),'unclassified']]){
        const f=setup({mode:'departure'});f.phone.afterMode=()=>{throw foreign;};
        await assert.rejects(f.controller.execute('applyChargingMode',{targetChargingMode:'departureClimate'}),error=>
            error.code==='charging_mode_outcome_unknown'&&error.message.includes('Ursache: '+cause+'.')&&!error.message.includes('SECRET')&&!error.message.includes('PRIVATE_CODE'));
        assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);
    }
    assert.equal(getterCalls,0);
});

test('stable mode and battery proof survives the former unguarded post-confirmation Range read',async()=>{
    for(const scenario of ['return-transition','return-close','return-battery','confirmation-battery']){
        const f=setup({mode:'departureClimate'});const original=f.phone.departureView.bind(f.phone);let afterHeader=0,injected=false;
        f.phone.departureView=async()=>{
            const view=await original();
            if(f.phone.modeBackNativeCalls===1&&f.phone.page==='range'&&++afterHeader===(scenario==='confirmation-battery'?1:2)){
                injected=true;
                const xml=scenario==='return-transition'
                    ?chargingModeScreen({mode:f.phone.mode}).replace('content-desc="Ladeverfahren"','content-desc="Zwischenansicht"')
                    :scenario==='return-close'?rangeModeScreen({mode:f.phone.mode}).replace('content-desc="Schließen"','content-desc="Zwischenansicht"')
                        :rangeModeScreen({mode:f.phone.mode}).replace('text="Batterie 52 %"','text="Batterie 53 %"');
                return {observation:nativeObservationFromXml(xml)};
            }
            return view;
        };
        const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departure'});
        assert.equal(injected,true);assert.equal(result.charging.mode,'departure');assert.deepEqual(result.battery,{soc:52,rangeKm:205});
        assert.equal(f.phone.modeTaps,1);assert.equal(f.phone.modeBackNativeCalls,1);assert.equal(f.store.reservations,1);
        assert.equal(f.phone.page,'overview');assert.equal(f.phone.calls.filter(c=>c[0]==='connect').length,1);
    }
});

test('Home-to-Range recovery after the one header return settles transient reads before any new navigation',async()=>{
    const f=setup({mode:'departureClimate'});const read=f.phone.departureView.bind(f.phone),action=f.phone.departureAction.bind(f.phone);
    let returnedHome=false,transitions=0;
    f.phone.departureAction=async request=>{
        const result=await action(request);
        if(request.action!=='click')return result;
        f.phone.page='overview';f.phone.lower=true;returnedHome=true;
        return {...result,postRead:{observation:nativeObservationFromXml(await f.phone.dump())}};
    };
    f.phone.departureView=async()=>{
        const view=await read();
        if(returnedHome&&f.phone.page==='overview'&&transitions++<2){
            return {observation:nativeObservationFromXml(chargingModeScreen().replace('content-desc="Ladeverfahren"','content-desc="Zwischenansicht"'))};
        }
        return view;
    };
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departure'});
    assert.equal(result.charging.mode,'departure');assert.ok(transitions>=2);
    assert.equal(f.phone.modeTaps,1);assert.equal(f.phone.modeBackNativeCalls,1);assert.equal(f.store.reservations,1);
    assert.equal(f.phone.calls.filter(c=>c[0]==='tap'&&c[1]==='overview'&&c[2]===POINTS.range.x).length,2);
    assert.equal(f.phone.page,'overview');
});

test('used mode and battery timestamps remain those of the consistent snapshot before a delayed return read',async()=>{
    const f=setup({mode:'departureClimate'});let afterHeader=0;
    f.phone.beforeExtended=()=>{
        if(f.phone.modeBackNativeCalls===1&&f.phone.page==='range'&&++afterHeader===2)f.clock.value+=10000;
    };
    const result=await f.controller.execute('applyChargingMode',{targetChargingMode:'departure'});
    assert.equal(result.charging.mode,'departure');assert.equal(result.modeObservedAt,result.observedAt);
    assert.ok(f.clock.value-Date.parse(result.modeObservedAt)>=10000);
    assert.equal(f.phone.modeTaps,1);assert.equal(f.store.reservations,1);assert.equal(f.phone.page,'overview');
});

test('advertised but invalid native navigation observation fails closed before any cached target or getter',async()=>{
    for(const accessor of [false,true]){
        const f=setup({mode:'departure',page:'chargingMode'});let getters=0,standardReads=0;
        f.phone.dump=async()=>{standardReads++;return rangeScreen();};
        f.phone.departureView=async()=>accessor?Object.defineProperty({xml:rangeScreen()},'observation',{get(){getters++;return {};}})
            :{xml:rangeScreen(),observation:{}};
        await rejects(f.controller.execute('chargingStatus'),'extended_ui_unavailable');
        assert.equal(getters,0);assert.equal(standardReads,0);
        assert.ok(!f.phone.calls.some(c=>c[0]==='tap'));noCtas(f.phone,f.store);
    }
});
