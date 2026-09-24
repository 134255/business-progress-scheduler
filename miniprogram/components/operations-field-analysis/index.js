const service=require('../../services/business')
const {fieldErrorMessage}=require('../../utils/operations-field-report')
const {catalogSelection,formatAnalysisPage,reduceAnalysisSelection}=require('../../utils/operations-field-analysis')
const key=value=>JSON.stringify(value)
const active=()=>{const user=getApp().globalData.currentUser;return user && user.status==='active'?user:null}
const empty=()=>({nodes:[],catalogLoading:false,catalogError:'',catalogHasMore:false,catalogCursor:'',catalogNotice:'',
  selectedId:'',panel:null,panelLoading:false,panelError:'',pairOptions:[],pairLeft:-1,pairRight:-1,linkOptions:[],linkIndex:0,path:[]})
Component({
  properties:{enabled:Boolean,query:Object,sessionEpoch:Number},
  data:empty(),
  observers:{'enabled, query, sessionEpoch'(){if(this._alive){this.resetAnalysis();if(this.data.enabled && !this._hidden) this.loadMoreNodes()}}},
  lifetimes:{attached(){this._alive=true;this._hidden=false;this.resetAnalysis();if(this.data.enabled)this.loadMoreNodes()},
    detached(){this._alive=false;this.resetAnalysis()}},
  pageLifetimes:{hide(){this._hidden=true;this.resetAnalysis()},show(){this._hidden=false}},
  methods:{
    resetAnalysis(){this._generation=(this._generation||0)+1;this._owner=active();this._role=this._owner && this._owner.role;
      this._selection=catalogSelection();this._nodeDimensions=[];this._lastAppend=false;this.setData(empty())},
    allowed(){
      if(!this._alive || this._hidden || !this.data.enabled) return false
      if(!active() || active()!==this._owner || active().role!==this._role){this.resetAnalysis();return false}
      return true
    },
    async request(selection,cursor='',catalog=false){
      if(!this.allowed())return
      const owner=this._owner,role=this._role,epoch=this.data.sessionEpoch,queryKey=key(this.data.query),selectionKey=key(selection),generation=++this._generation
      const current=()=>this.allowed() && this._owner===owner && this._role===role && this.data.sessionEpoch===epoch &&
        generation===this._generation && key(this.data.query)===queryKey && (catalog || key(this._selection)===selectionKey)
      this.setData(catalog?{catalogLoading:true,catalogError:''}:{panelLoading:true,panelError:''})
      this._lastAppend=Boolean(cursor)
      try {
        const raw=await service.getOperationsFieldAnalysis({...this.data.query,analysis:selection,pageSize:50,cursor})
        if(!current())return
        const page=formatAnalysisPage(raw)
        if(key(page.context)!==selectionKey)throw new Error('ANALYSIS_CONTEXT_CHANGED')
        if(catalog){
          const nodes=cursor?[...this.data.nodes,...page.items]:page.items
          if(new Set(nodes.map(n=>n.id)).size!==nodes.length)throw new Error('DUPLICATE_PAGE')
          this.setData({nodes,catalogHasMore:page.hasMore,catalogCursor:page.nextCursor,
            catalogNotice:page.incomplete?'部分最终数据尚未补齐，以下仅为已核实样本，暂不能导出完整文件。':`${page.scopeNotice} · 已核实 ${page.sampleCount} 个完成节点`})
        }else{
          const items=cursor && this.data.panel?[...this.data.panel.items,...page.items]:page.items
          if(new Set(items.map(i=>i.id||i.key)).size!==items.length)throw new Error('DUPLICATE_PAGE')
          if(page.hasMore && page.nextCursor===cursor)throw new Error('CURSOR_LOOP')
          this.setData({panel:{...page,items}})
          if(page.view==='node'){
            this._nodeDimensions=page.dimensionMetadata
            this.setData({pairOptions:page.dimensionMetadata,linkOptions:page.linkages,linkIndex:0})
          }
        }
      }catch(error){
        // A cancelled UI request can still prove same-session access was lost.
        if(['FORBIDDEN','ACCOUNT_DISABLED'].includes(error && error.code) && this._alive && active()===owner &&
          active().role===role){this.resetAnalysis();this.triggerEvent('accessinvalid');return}
        if(!current())return
        if(['REPORT_CHANGED','REPORT_EXPIRED'].includes(error && error.code) && cursor){
          this.triggerEvent('sourceinvalid')
          this.setData(catalog?{nodes:[],catalogCursor:'',catalogHasMore:false}:{panel:null})
          return this.request(selection,'',catalog)
        }
        this.setData(catalog?{catalogError:fieldErrorMessage(error,'字段目录加载失败，请重试。')}:
          {panelError:fieldErrorMessage(error,'分析加载失败，请重试；若字段版本不兼容，请重新选择。')})
      }finally{if(current())this.setData(catalog?{catalogLoading:false}:{panelLoading:false})}
    },
    async loadMoreNodes(){if(!this.allowed() || this.data.catalogLoading || this.data.panelLoading)return;
      return this.request(catalogSelection(),this.data.catalogCursor,true)},
    changeSelection(next){
      if(!this.allowed())return
      this._generation++;this._selection=next;this._lastAppend=false
      if(next.nodeGroupId!==this.data.selectedId || next.view==='catalog'){
        this._nodeDimensions=[];this.setData({pairOptions:[],pairLeft:-1,pairRight:-1,linkOptions:[],linkIndex:0})
      }
      this.setData({selectedId:next.nodeGroupId,panel:null,panelLoading:false,panelError:'',catalogLoading:false,path:next.filters.map(f=>({
        dimensionId:f.dimensionId,name:(this._nodeDimensions.find(d=>d.id===f.dimensionId)||{}).name||'条件',value:f.value}))})
      this.triggerEvent('analysischange',{selection:next})
      if(next.view!=='catalog')return this.request(next)
    },
    toggleNode(event){const id=event.currentTarget.dataset.id;if(!this.data.nodes.some(n=>n.id===id))return;
      return this.changeSelection(reduceAnalysisSelection(this._selection,{type:this.data.selectedId===id?'catalog':'node',id}))},
    nodeOverview(){return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'node',id:this.data.selectedId}))},
    showAllOptions(event){const id=event.currentTarget.dataset.id;
      if(!this.data.panel || !this.data.panel.bundled || !this.data.panel.items.some(i=>i.id===id))return
      return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'field',id}))},
    onLinkChange(event){this.setData({linkIndex:Number(event.detail.value)})},
    startProduct(){const link=this.data.linkOptions[this.data.linkIndex];if(!link)return;
      return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'product',id:link.id}))},
    selectProductValue(event){
      const panel=this.data.panel,index=Number(event.currentTarget.dataset.index)
      if(!panel || panel.view!=='product' || panel.productStage!=='next' || !panel.items[index])return
      return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'productValue',index:this._selection.filters.length,
        dimensionId:panel.dimensionMetadata[0].id,value:panel.items[index].values[0]}))
    },
    backProduct(){return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'backProduct'}))},
    resetProduct(){return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'resetProduct'}))},
    showCombinations(){if(this._selection.view!=='product' || this._selection.filters.length<3)return;
      return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'combinations'}))},
    selectPairDimension(event){
      const side=event.currentTarget.dataset.side,value=Number(event.detail.value)
      if(!['pairLeft','pairRight'].includes(side) || !this.data.pairOptions[value])return
      this.setData({[side]:value})
      const left=this.data.pairOptions[this.data.pairLeft],right=this.data.pairOptions[this.data.pairRight]
      if(left && right && left.id!==right.id)return this.changeSelection(reduceAnalysisSelection(this._selection,{type:'pair',ids:[left.id,right.id]}))
      if(this._selection.view==='pair')return this.nodeOverview()
    },
    loadMoreAnalysis(){if(!this.data.panel || !this.data.panel.hasMore || this.data.panelLoading)return;
      return this.request(this._selection,this.data.panel.nextCursor)},
    retryAnalysis(){if(this.data.panelLoading)return;return this.request(this._selection,this._lastAppend && this.data.panel?this.data.panel.nextCursor:'')}
  }
})
