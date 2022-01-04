using Microsoft.Extensions.Configuration;

namespace FortyTwo.Entity
{
    public class DatabaseContextFactory
    {
        private readonly IConfiguration _configuration;

        public DatabaseContextFactory(IConfiguration configuration)
        {
            _configuration = configuration;
        }

        public DatabaseContext Create()
        {
            return new DatabaseContext(_configuration);
        }
    }
}