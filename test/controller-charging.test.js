'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../lib/controller');
const { BridgeError } = require('../lib/errors');
const { overviewChargingScreen, rangeScreen, chargingSettingsScreen, chargingFooterScreen, POINTS } = require('./support/charging-fixtures.cjs');
const { completeDemoClimate } = require('./support/settings-fixtures.cjs');
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
            const view=rangeScreen({soc:this.soc,rangeKm:this.rangeKm});
            return this.missingDetailRange ? view.replace('Übersicht Reichweite. Batteriereichweite: '+this.rangeKm+' Kilometer','Unbekannte Reichweitenanzeige') : view;
        }
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
    async departureView(){this.homeSnapshot=Object.freeze({});return {xml:await this.dump(),observation:this.homeSnapshot};}
    async departureAction(request){
        assert.equal(request.snapshot,this.homeSnapshot);assert.equal(request.action,'scrollBackward');
        assert.equal(request.header,'Ihr Fahrzeug: Testwagen. Gerade synchronisiert');
        assert.deepEqual(request.target,{class:'android.widget.ScrollView',bounds:[20,100,980,1300]});
        this.calls.push(['homeNativeAction','scrollBackward']);this.lower=false;
        return {beforeMatched:true,actionAttempted:true,actionAccepted:true,success:true,errorCode:null,postRead:{xml:await this.dump()}};
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
            if(x===POINTS.back.x&&y===POINTS.back.y){this.page='overview';return;}
            this.chargingCtas++;throw new Error('Charging CTA must never be touched');
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
    assert.equal(result.domain,'charging');assert.deepEqual(result.battery,{soc:52,rangeKm:205});assert.deepEqual(result.charging,INITIAL);
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
    assert.deepEqual(result.charging,wanted);assert.deepEqual(phone.saved,wanted);assert.equal(result.changed,true);
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
