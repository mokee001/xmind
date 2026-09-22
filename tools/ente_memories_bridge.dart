// Local test seam only. The private upstream calculation remains unchanged.
part of 'smart_memories_service.dart';

Future<MemoriesResult> photoWallLabCalculate(MemoriesComputationContext context) =>
    SmartMemoriesService._allMemoriesCalculations(context.toIsolateArgs());

// Read-only diagnostics from the same upstream constants, vectors and windows.
Map<String,dynamic> photoWallLabDiagnostics(MemoriesComputationContext context, StringsLocalizations locals, {
  Map<int,EnteFile>? recognitionFiles,List<EmbeddingVector>? recognitionEmbeddings,
}) {
  final allFiles=recognitionFiles??context.allFileIdsToFile;
  final allEmbeddings=recognitionEmbeddings??context.allImageEmbeddings;
  final datedHashes=context.allFileIdsToFile.values.map((f)=>f.localID).toSet();
  final index=MemoryFileIndex(context.allFileIdsToFile.values);
  final themes=ClipMemoryType.values.map((type) {
    final query=context.clipMemoryTypeVectors[type]!;
    final matches=allEmbeddings.map((v)=><String,dynamic>{
      'sha256':allFiles[v.fileID]!.localID,
      'score':v.vector.dot(query),
    }).where((m)=>(m['score'] as double)>SmartMemoriesService._clipMemoryTypeQueryThreshold).toList()
      ..sort((a,b)=>(b['score'] as double).compareTo(a['score'] as double));
    return <String,dynamic>{'type':type.name,
      'title':ClipMemory([],0,0,type).createTitle(locals,'zh'),
      'matching_count':matches.length,'memory_matching_count':matches.where((m)=>datedHashes.contains(m['sha256'])).length,'matches':matches};
  }).toList()..sort((a,b)=>(b['matching_count'] as int).compareTo(a['matching_count'] as int));
  return {'photo_count':allFiles.length,'embedding_count':allEmbeddings.length,
    'memory_input_count':context.allFileIdsToFile.length,'unknown_date_count':allFiles.length-context.allFileIdsToFile.length,
    'clip_threshold':SmartMemoriesService._clipMemoryTypeQueryThreshold,
    // Fixed pinned upstream buildClipMemory rejects scoredFiles.length < 10.
    'clip_minimum_candidates':10,'themes':themes,
    'unnamed_minimum_nonconsecutive_days':SmartMemoriesService._minimumUnnamedPeopleNonConsecutiveDays,
    'historical_window_files':TimeMemoriesCalculator._filesForHistoricalWindow(index,context.now).length,
    'recent_window_files':TimeMemoriesCalculator._filesForRecentTimeMemories(index,context.now).length,
    'dated_window_files':TimeMemoriesCalculator._filesForTimeMemories(index,context.now).length,
    'files_with_city':context.citySearchIndex.assignments.length};
}
