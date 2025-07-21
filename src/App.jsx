import { useEffect, useState } from "react";
import Search from "./components/Search.jsx";
import Spinner from "./components/Spinner.jsx";
import MovieCard from "./components/MovieCard.jsx";
import { useDebounce } from "react-use";
import { getTrendingMovies, updateSearchCount } from "./appwrite.js";

const API_BASE_URL = "https://api.themoviedb.org/3";
const API_KEY = import.meta.env.VITE_TMDB_API_KEY;

const API_OPTIONS = {
  method: "GET",
  headers: {
    accept: "application/json",
    Authorization: `Bearer ${API_KEY}`,
  },
};

const App = () => {
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const [movieList, setMovieList] = useState([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [trendingMovies, setTrendingMovies] = useState([]);

  // Debounce the search term to prevent making too many API requests
  // by waiting for the user to stop typing for 500ms
  useDebounce(() => setDebouncedSearchTerm(searchTerm), 500, [searchTerm]);

  // Enhanced fuzzy search preprocessing
  const preprocessSearchTerm = (term) => {
    // Handle common typos and variations
    const corrections = {
      spiderman: "spider-man",
      xmen: "x-men",
      batman: "batman",
      superman: "superman",
      ironman: "iron man",
      kerete: "karate",
      kerate: "karate",
      karete: "karate",
      dimon: "demon",
      deamon: "demon",
      daemon: "demon",
    };

    const lowerTerm = term.toLowerCase().trim();
    return corrections[lowerTerm] || term;
  };

  // Generate phonetic and character variations
  const generateSearchVariations = (term) => {
    const variations = [term];
    const lowerTerm = term.toLowerCase();

    // Common character substitutions
    const substitutions = {
      i: ["e", "a"],
      e: ["i", "a"],
      a: ["e", "i"],
      o: ["u", "a"],
      u: ["o", "i"],
      y: ["i", "e"],
      c: ["k", "s"],
      k: ["c", "ck"],
      s: ["c", "z"],
      z: ["s"],
      ph: ["f"],
      f: ["ph"],
      tion: ["sion"],
      sion: ["tion"],
    };

    // Generate variations by substituting similar characters
    for (let i = 0; i < lowerTerm.length; i++) {
      const char = lowerTerm[i];
      if (substitutions[char]) {
        for (const substitute of substitutions[char]) {
          const variation =
            lowerTerm.substring(0, i) + substitute + lowerTerm.substring(i + 1);
          if (variation !== lowerTerm && !variations.includes(variation)) {
            variations.push(variation);
          }
        }
      }
    }

    return variations;
  };

  // Calculate Levenshtein distance for better fuzzy matching
  const levenshteinDistance = (str1, str2) => {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1 // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  };

  const fetchMovies = async (query = "") => {
    setIsLoading(true);
    setErrorMessage("");

    try {
      let allResults = [];

      if (query) {
        // Preprocess the search term for better results
        const processedQuery = preprocessSearchTerm(query);
        const searchVariations = generateSearchVariations(processedQuery);

        // Try multiple search strategies for better fuzzy results
        const searchPromises = [
          // Original search
          fetch(
            `${API_BASE_URL}/search/movie?query=${encodeURIComponent(
              processedQuery
            )}`,
            API_OPTIONS
          ),
          // Search with character variations
          ...searchVariations
            .slice(1, 4)
            .map((variation) =>
              fetch(
                `${API_BASE_URL}/search/movie?query=${encodeURIComponent(
                  variation
                )}`,
                API_OPTIONS
              )
            ),
          // Search with individual words if the query has spaces
          ...(processedQuery.includes(" ")
            ? processedQuery
                .split(" ")
                .map((word) =>
                  fetch(
                    `${API_BASE_URL}/search/movie?query=${encodeURIComponent(
                      word
                    )}`,
                    API_OPTIONS
                  )
                )
            : []),
          // Also try a broad search with just the first few characters for very fuzzy matching
          fetch(
            `${API_BASE_URL}/search/movie?query=${encodeURIComponent(
              processedQuery.substring(0, 3)
            )}`,
            API_OPTIONS
          ),
        ];

        const responses = await Promise.all(searchPromises);

        for (const response of responses) {
          if (response.ok) {
            const data = await response.json();
            if (data.results) {
              allResults = [...allResults, ...data.results];
            }
          }
        }

        // Remove duplicates and sort by relevance
        const uniqueResults = allResults.filter(
          (movie, index, self) =>
            index === self.findIndex((m) => m.id === movie.id)
        );

        // Enhanced relevance scoring with original query
        const scoredResults = uniqueResults.map((movie) => ({
          ...movie,
          relevanceScore: calculateRelevanceScore(movie, query), // Use original query for scoring
        }));

        // Sort by relevance score
        const sortedResults = scoredResults
          .sort((a, b) => b.relevanceScore - a.relevanceScore)
          .slice(0, 20); // Limit to top 20 results

        setMovieList(sortedResults);

        if (sortedResults.length > 0) {
          await updateSearchCount(query, sortedResults[0]);
        }
      } else {
        // Default discover endpoint for popular movies
        const endpoint = `${API_BASE_URL}/discover/movie?sort_by=popularity.desc`;
        const response = await fetch(endpoint, API_OPTIONS);

        if (!response.ok) {
          throw new Error("Failed to fetch movies");
        }

        const data = await response.json();
        setMovieList(data.results || []);
      }
    } catch (error) {
      console.error(`Error fetching movies: ${error}`);
      setErrorMessage("Error fetching movies. Please try again later.");
    } finally {
      setIsLoading(false);
    }
  };

  // Calculate relevance score for better fuzzy matching
  const calculateRelevanceScore = (movie, query) => {
    const queryLower = query.toLowerCase();
    const titleLower = movie.title.toLowerCase();
    const overviewLower = (movie.overview || "").toLowerCase();

    let score = 0;

    // Exact title match gets highest score
    if (titleLower === queryLower) score += 100;

    // Title contains query gets high score
    if (titleLower.includes(queryLower)) score += 80;

    // Title starts with query gets good score
    if (titleLower.startsWith(queryLower)) score += 70;

    // Overview contains query gets medium score
    if (overviewLower.includes(queryLower)) score += 30;

    // Levenshtein distance scoring for fuzzy matching
    const titleWords = titleLower.split(" ");
    const queryWords = queryLower.split(" ");

    let bestWordMatch = 0;
    for (const titleWord of titleWords) {
      for (const queryWord of queryWords) {
        const distance = levenshteinDistance(titleWord, queryWord);
        const maxLen = Math.max(titleWord.length, queryWord.length);
        const similarity = (maxLen - distance) / maxLen;

        if (similarity > 0.6) {
          // 60% similarity threshold
          bestWordMatch = Math.max(bestWordMatch, similarity * 60);
        }
      }
    }
    score += bestWordMatch;

    // Also check full title fuzzy match
    const titleDistance = levenshteinDistance(titleLower, queryLower);
    const titleMaxLen = Math.max(titleLower.length, queryLower.length);
    const titleSimilarity = (titleMaxLen - titleDistance) / titleMaxLen;

    if (titleSimilarity > 0.5) {
      score += titleSimilarity * 40;
    }

    // Fuzzy character matching (original method as backup)
    score += calculateFuzzyScore(titleLower, queryLower) * 20;

    // Boost score for more popular movies (vote_average and vote_count)
    score += (movie.vote_average || 0) * 1;
    score += Math.min((movie.vote_count || 0) / 1000, 5);

    return score;
  };

  // Simple fuzzy matching score
  const calculateFuzzyScore = (text, query) => {
    let matchCount = 0;
    let lastIndex = -1;

    for (const char of query) {
      const index = text.indexOf(char, lastIndex + 1);
      if (index > lastIndex) {
        matchCount++;
        lastIndex = index;
      }
    }

    return matchCount / query.length;
  };

  const loadTrendingMovies = async () => {
    try {
      const movies = await getTrendingMovies();
      setTrendingMovies(movies);
    } catch (error) {
      console.error(`Error fetching trending movies: ${error}`);
    }
  };

  useEffect(() => {
    fetchMovies(debouncedSearchTerm);
  }, [debouncedSearchTerm]);

  useEffect(() => {
    loadTrendingMovies();
  }, []);

  return (
    <main>
      <div className="pattern" />

      <div className="wrapper">
        <header>
          <img src="./hero.png" alt="Hero Banner" />
          <h1>
            Find <span className="text-gradient">Movies</span> You'll Enjoy
            Without the Hassle
          </h1>

          <Search searchTerm={searchTerm} setSearchTerm={setSearchTerm} />
        </header>

        {trendingMovies.length > 0 && !searchTerm && (
          <section className="trending">
            <h2>Trending Movies</h2>

            <ul>
              {trendingMovies.map((movie, index) => (
                <li key={movie.$id}>
                  <p>{index + 1}</p>
                  <img src={movie.poster_url} alt={movie.title} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="all-movies">
          <h2>
            {searchTerm ? `Search Results for "${searchTerm}"` : "All Movies"}
          </h2>

          {isLoading ? (
            <Spinner />
          ) : errorMessage ? (
            <p className="text-red-500">{errorMessage}</p>
          ) : movieList.length === 0 && searchTerm ? (
            <p>
              No movies found for "{searchTerm}". Try a different search term.
            </p>
          ) : (
            <ul>
              {movieList.map((movie) => (
                <MovieCard key={movie.id} movie={movie} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
};

export default App;
