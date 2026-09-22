// Thin local harness: all image preprocessing and inference run in ente-ml.
// Install as rust/crates/ml/examples/photo_wall_lab.rs in the pinned checkout.
use std::{fs, io::{self, BufRead}};
use ente_ml::{ModelPaths, indexing::{AnalyzeImageRequest, ImageSource, analyze_image, RunClipTextRequest, run_clip_text}};
use serde_json::{json, Value};

fn execute() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let config: Value = serde_json::from_slice(&fs::read(&args[1])?)?;
    let path = |key: &str| config["models"][key].as_str().unwrap().to_string();
    let models = ModelPaths {face_detection:path("face_detection"), face_embedding:path("face_embedding"), clip_image:path("clip_image"), clip_text:path("clip_text"), ..Default::default()};
    // One request per line, one result per line. No network or app initialization.
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        if let Some(coordinates) = request["coordinates"].as_array() {
            let cities=ente_location::CityIndex::from_path(config["cities"].as_str().unwrap())?;
            let urban=ente_location::UrbanCenterIndex::from_path(config["urban"].as_str().unwrap())?;
            let coordinates:Vec<_>=coordinates.iter().map(|p|ente_location::Coordinate::new(p[0].as_f64().unwrap(),p[1].as_f64().unwrap())).collect();
            let result=urban.match_coordinates_with_cities(&cities,&coordinates,"");
            println!("{}",json!({"cities":result.iter().map(|m|json!({"name":m.city.name,"country":m.city.country_name,"latitude":m.city.latitude,"longitude":m.city.longitude,"indices":m.coordinate_indices})).collect::<Vec<_>>()}));
        } else if let Some(text) = request["text"].as_str() {
            let result = run_clip_text(RunClipTextRequest {text:text.into(), model_path:path("clip_text"), vocab_path:path("clip_text_vocab")})?;
            println!("{}", json!({"text":text,"embedding":result.embedding}));
        } else {
            let id = request["id"].as_i64().unwrap();
            let result = analyze_image(AnalyzeImageRequest {file_id:id, source:ImageSource::Path(request["path"].as_str().unwrap().into()), run_faces:true, run_clip:true, run_pets:false, generate_face_crops:false, model_paths:models.clone()})?;
            let faces: Vec<Value> = result.faces.unwrap_or_default().iter().map(|face| json!({"face_id":face.face_id,"box":face.detection.box_xyxy,"landmarks":face.detection.keypoints,"score":face.detection.score,"blur":face.blur_value,"embedding":face.embedding})).collect();
            println!("{}",json!({"id":id,"faces":faces,"embedding":result.clip.unwrap().embedding,"used_coreml":result.used_coreml,"used_webgpu":result.used_webgpu}));
        }
    }
    Ok(())
}
fn main() -> anyhow::Result<()> {
    std::thread::Builder::new().stack_size(64*1024*1024).spawn(execute)?.join().expect("Ente ML worker panicked")
}
