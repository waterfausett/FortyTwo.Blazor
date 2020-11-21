using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using FortyTwo.Shared.Models;

namespace FortyTwo.Client.ViewModels
{
    public interface IDominoModel
    {
        Task<Domino[]> ShuffleAsync();
    }

    public class DominoViewModel : IDominoModel
    {
        private HttpClient _http;

        public DominoViewModel(HttpClient http)
        {
            _http = http;
        }

        public async Task<Domino[]> ShuffleAsync()
        {
            var response = await _http.GetAsync("Dominos");
            response.EnsureSuccessStatusCode();

            var responseContent = await response.Content.ReadAsStringAsync();

            return JsonSerializer.Deserialize<Domino[]>(responseContent, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        }
    }
}
