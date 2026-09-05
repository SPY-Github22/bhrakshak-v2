plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.bhrakshak.field"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bhrakshak.field"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        // Active Cloudflare tunnel endpoint (works anywhere, mobile data + Wi-Fi)
        buildConfigField("String", "API_BASE_URL", "\"https://wars-yrs-regularly-evaluating.trycloudflare.com\"")
        buildConfigField("String", "WS_URL", "\"wss://wars-yrs-regularly-evaluating.trycloudflare.com/ws/live\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging {
        resources.excludes += "META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // lifecycle
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")

    // network: Retrofit + OkHttp + kotlinx serialization
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    implementation("com.jakewharton.retrofit:retrofit2-kotlinx-serialization-converter:1.0.0")

    // offline queue: Room (KSP generates the DAO impls; without this the
    // database builder cannot resolve the abstract class at runtime)
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // background sync
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // secure token storage
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // location
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // live alerts
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
