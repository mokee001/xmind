// Local dataset harness, not a replacement selection implementation.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:ente_strings/ente_strings.dart';
import 'package:ml_linalg/vector.dart';
import 'package:photos/generated/protos/ente/common/vector.pb.dart';
import 'package:photos/models/file/file.dart';
import 'package:photos/models/file/file_type.dart';
import 'package:photos/models/location/location.dart';
import 'package:photos/models/memories/clip_memory.dart';
import 'package:photos/models/memories/people_memory.dart';
import 'package:photos/models/memories/memories_cache.dart';
import 'package:photos/models/ml/face/detection.dart';
import 'package:photos/models/ml/face/face_with_embedding.dart';
import 'package:photos/models/ml/vector.dart';
import 'package:photos/services/location_service.dart';
import 'package:photos/services/memories/memories_computation_context.dart';
import 'package:photos/services/smart_memories_service.dart';
import 'package:photos/services/machine_learning/face_ml/face_clustering/face_clustering_service.dart';
import 'package:photos/services/machine_learning/face_ml/face_clustering/face_db_info_for_clustering.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as timezone;

class NoNetwork extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      throw StateError('Network is disabled in the Ente local replay');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('Ente local memories replay', () async {
    HttpOverrides.global=NoNetwork();
    tzdata.initializeTimeZones();
    timezone.setLocalLocation(timezone.getLocation('Asia/Shanghai'));
    final input=jsonDecode(File(Platform.environment['ENTE_LAB_INPUT']!).readAsStringSync()) as Map<String,dynamic>;
    final files=<int,EnteFile>{};
    final hashes=<int,String>{};
    final creationTimes=<int,int>{};
    final faces=<int,List<FaceWithoutEmbedding>>{};
    final clusterInput=<FaceDbInfoForClustering>{};
    final embeddings=<EmbeddingVector>[];
    final cities=<EnteFile,City>{};
    for(final item in input['photos'] as List) {
      final id=item['id'] as int;
      final file=EnteFile()..generatedID=id..localID=item['sha256']..title=item['filename']..fileType=FileType.image..creationTime=item['creation_time']..modificationTime=item['creation_time'];
      if(item['latitude']!=null) file.location=Location(latitude:(item['latitude'] as num).toDouble(),longitude:(item['longitude'] as num).toDouble());
      files[id]=file;hashes[id]=item['sha256'];
      if(file.creationTime!=null) creationTimes[id]=file.creationTime!;
      final city=item['city'];
      if(city!=null) cities[file]=City(city:city['name'],country:city['country'],lat:(city['latitude'] as num).toDouble(),lng:(city['longitude'] as num).toDouble());
      embeddings.add(EmbeddingVector(fileID:id,embedding:List<double>.from(item['embedding'])));
      faces[id]=[];
      for(final face in item['faces'] as List) {
        final box=List<double>.from(face['box']);
        final detection=Detection.fromJson({'box':{'x':box[0],'y':box[1],'width':box[2]-box[0],'height':box[3]-box[1]},'landmarks':(face['landmarks'] as List).map((p)=>{'x':p[0],'y':p[1]}).toList()});
        final score=(face['score'] as num).toDouble(), blur=(face['blur'] as num).toDouble();
        faces[id]!.add(FaceWithoutEmbedding(face['face_id'],id,score,detection,blur));
        clusterInput.add(FaceDbInfoForClustering(faceID:face['face_id'],embeddingBytes:EVector(values:List<double>.from(face['embedding'])).writeToBuffer(),faceScore:score,blurValue:blur,isSideways:detection.faceIsSideways()));
      }
    }
    final clusters=runLinearClustering({'input':clusterInput,'fileIDToCreationTime':creationTimes,'distanceThreshold':FaceClusteringService.kRecommendedDistanceThreshold,'conservativeDistanceThreshold':FaceClusteringService.kConservativeDistanceThreshold,'useDynamicThreshold':true,'offset':null,'oldClusterSummaries':<String,(Uint8List,int)>{}});
    Vector query(String text) => Vector.fromList(List<double>.from(input['texts'][text]));
    final locals=await StringsLocalizations.delegate.load(const Locale('zh','CN'));
    final now=DateTime.parse(input['as_of']).toLocal();
    final outputs=<String,dynamic>{};
    final faceSources=<String,Map<String,dynamic>>{};
    for(final item in input['photos'] as List) {
      for(final face in item['faces'] as List) {
        faceSources[face['face_id']]={'face_id':face['face_id'],'sha256':item['sha256'],
          'box':face['box'],'score':face['score']};
      }
    }
    expect(embeddings.length,files.length);
    expect(embeddings.every((e)=>e.vector.length==512 && (e.vector.norm()-1).abs()<0.00001),isTrue);
    expect(files.keys.toSet(),embeddings.map((e)=>e.fileID).toSet());
    final datedFiles=Map<int,EnteFile>.fromEntries(files.entries.where((e)=>e.value.creationTime!=null));
    final datedEmbeddings=embeddings.where((e)=>datedFiles.containsKey(e.fileID)).toList();
    for(final debug in [false,true]) {
      final context=MemoriesComputationContext(allFileIdsToFile:datedFiles,collectionIDsToExclude:{},isLocalGalleryMode:true,mlEnabled:true,now:now,oldCache:MemoriesCache(toShowMemories:[],peopleShownLogs:[],clipShownLogs:[],tripsShownLogs:[],baseLocations:[]),debugSurfaceAll:debug,canUseUnnamedFallback:true,seenTimes:{},persons:[],currentUserEmail:null,citySearchIndex:CitySearchIndex(cities),fileIdToFaces:faces,clusterIdToFaceCount:clusters.newClusterIdToFaceIds.map((id,list)=>MapEntry(id,list.length)),clusterIdToFaceIDs:clusters.newClusterIdToFaceIds,assignedClusterIDs:{},allImageEmbeddings:datedEmbeddings,clipPositiveTextVector:query(input['positive_query']),clipPeopleActivityVectors:{for(final activity in PeopleActivity.values) activity:query(activityQuery(activity))},clipMemoryTypeVectors:{for(final type in ClipMemoryType.values) type:query(clipQuery(type))});
      final result=await photoWallLabCalculate(context);
      if(result.failed) throw StateError('Upstream memories calculation failed');
      final memories=debug?result.memories:result.memories.where((m)=>!m.notForShow&&now.microsecondsSinceEpoch>=m.firstDateToShow&&now.microsecondsSinceEpoch<=m.lastDateToShow).toList();
      final diagnostics=photoWallLabDiagnostics(context,locals,recognitionFiles:files,recognitionEmbeddings:embeddings);
      diagnostics.addAll({'cluster_count':clusters.newClusterIdToFaceIds.length,'face_count':clusterInput.length,'largest_cluster_faces':clusters.newClusterIdToFaceIds.values.fold<int>(0,(n,faces)=>faces.length>n?faces.length:n)});
      diagnostics['detected_faces']=faceSources.values.toList();
      diagnostics['person_groups']=clusters.newClusterIdToFaceIds.entries.map((entry)=>{
        'cluster_id':entry.key,'faces':entry.value.map((id)=>faceSources[id]!).toList(),
      }).toList();
      outputs[debug?'debug_all_candidates':'natural']={'memories':memories.map((memory)=>{'id':memory.id,'title':memory.createTitle(locals,'zh'),'photo_sha256':memory.memories.map((m)=>hashes[m.file.generatedID]!).toList(),'cover_sha256':hashes[memory.memories.first.file.generatedID]!,'type':memory.type.name}).toList(),'diagnostics':diagnostics};
    }
    File(Platform.environment['ENTE_LAB_OUTPUT']!).writeAsStringSync(jsonEncode(outputs));
    expect(outputs.keys,contains('natural'));
  },timeout:const Timeout(Duration(minutes:10)));
}
