using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using FortyTwo.Client.Store;
using FortyTwo.Shared.Models.DTO;

namespace FortyTwo.Client.ViewModels
{
    public interface IMatchesViewModel
    {
        public bool IsLoading { get; set; }
        public Match[] Matches { get; }
        Task FetchMatchesAsync();
    }

    public class MatchesViewModel : IMatchesViewModel
    {
        private readonly HttpClient _http;
        private readonly IClientStore _store;

        public MatchesViewModel(HttpClient http, IClientStore store)
        {
            _http = http;
            _store = store;
        }

        public bool IsLoading { get; set; }

        public Match[] Matches
        {
            get => _store.Matches?.ToArray();
        }

        public async Task FetchMatchesAsync()
        {
            IsLoading = true;

            try
            {
                var matches = await _http.GetFromJsonAsync<List<Match>>("api/matches");

                _store.Matches = matches;
            }
            finally
            {
                IsLoading = false;
            }
        }
    }
}
