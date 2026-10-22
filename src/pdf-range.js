// File-backed range reads avoid copying a whole multi-hundred-MB PDF into the UI thread.
export function fileRangeTransport(file, RangeTransport, onError) {
  const transport=new RangeTransport(file.size,new Uint8Array(),false,file.name);
  let stopped=false;
  transport.requestDataRange=(begin,end)=>{
    file.slice(begin,end).arrayBuffer().then(buffer=>{if(!stopped)transport.onDataRange(begin,new Uint8Array(buffer));}).catch(onError);
  };
  transport.abort=()=>{stopped=true;};
  return transport;
}
